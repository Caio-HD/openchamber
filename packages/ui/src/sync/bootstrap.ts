import type { FormRequest, PermissionRequest, Project } from "@/lib/opencode/model"
import { opencodeClient } from "@/lib/opencode/client"
import { retry } from "./retry"
import type { GlobalState, State } from "./types"
import { runtimeFetch } from "../lib/runtime-fetch"
import { emitSyncConfigChanged } from "./sync-refs"
import { warmChatsRootDirectory } from "../lib/chatDirectories"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const requestSignature = (items: Array<{ id: string }> | undefined): string => {
  if (!items || items.length === 0) return ""
  return items
    .map((item) => item.id)
    .sort(cmp)
    .join("|")
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    else acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find(
    (project) => project.worktree === directory || project.sandboxes?.includes(directory),
  )?.id
}

/**
 * Replaces the per-session lists of pending requests with an authoritative
 * fetch, keeping sessions whose list changed underneath the request (a live
 * event landed while it was in flight) instead of clobbering them.
 */
function reconcilePendingRequests<T extends { id: string; sessionID: string }>(
  before: Record<string, T[]>,
  current: Record<string, T[]>,
  fetched: T[],
) {
  const beforeSignatures = new Map(
    Object.entries(before).map(([sessionID, items]) => [sessionID, requestSignature(items)]),
  )
  const grouped = groupBySession(fetched)
  const merged = { ...current }
  for (const [sessionID, items] of Object.entries(grouped)) {
    merged[sessionID] = items.sort((a, b) => cmp(a.id, b.id))
  }
  for (const sessionID of beforeSignatures.keys()) {
    if (grouped[sessionID]) continue
    const beforeSignature = beforeSignatures.get(sessionID) ?? ""
    const currentSignature = requestSignature(current[sessionID])
    if (currentSignature !== beforeSignature) continue
    delete merged[sessionID]
  }
  return merged
}

// ---------------------------------------------------------------------------
// Bootstrap global state
// ---------------------------------------------------------------------------

export async function bootstrapGlobal(set: (patch: Partial<GlobalState>) => void) {
  const results = await Promise.allSettled([
    // Sync chat classification needs the chats root before session lists load;
    // it resolves alongside the other bootstrap calls, not ahead of them.
    warmChatsRootDirectory(),
    retry(async () => {
      const [location, home] = await Promise.all([opencodeClient.getLocation(), opencodeClient.getFilesystemHome()])
      set({ path: { directory: location.directory, worktree: location.project.directory, home: home ?? "" } })
    }),
    retry(() => opencodeClient.getConfig().then((config) => set({ config }))),
    retry(() =>
      opencodeClient.listProjects().then((data) => {
        const projects = data
          .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
          .sort((a, b) => cmp(a.id, b.id))
        set({ projects })
      }),
    ),
  ])

  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)
  if (errors.length) {
    console.error("[bootstrap] global bootstrap failed", errors[0])
  }

  // If ALL requests failed, OpenCode is likely down — fetch the OpenChamber
  // health endpoint (outside the readiness gate) to get the actual error reason.
  if (errors.length === results.length) {
    let message = errors[0] instanceof Error ? errors[0].message : String(errors[0])
    try {
      const healthRes = await runtimeFetch("/health", { signal: AbortSignal.timeout(4000) })
      if (healthRes.ok) {
        const health = await healthRes.json()
        if (health.lastOpenCodeError) {
          message = health.lastOpenCodeError
        } else if (!health.openCodeRunning) {
          message = "OpenCode process is not running"
        }
      }
    } catch {
      // health endpoint itself unreachable — use the original error
    }
    set({ ready: true, error: { type: "init", message } })
  } else {
    set({ ready: true, error: undefined })
  }
}

// ---------------------------------------------------------------------------
// Bootstrap per-directory state
// ---------------------------------------------------------------------------

export async function bootstrapDirectory(input: {
  directory: string
  getState: () => State
  set: (patch: Partial<State>) => void
  isStale?: () => boolean
  global: {
    config: GlobalState["config"]
    projects: Project[]
    path: GlobalState["path"]
  }
  loadSessions: (directory: string) => Promise<void> | void
}): Promise<"complete" | "failed" | "stale"> {
  const { directory, getState, set, global: g } = input
  const commit = (patch: Partial<State>): boolean => {
    if (input.isStale?.()) return false
    set(patch)
    return true
  }
  const state = getState()
  const loading = state.status !== "complete"

  // Seed from global state while we fetch directory-specific data
  const seededProject = projectID(directory, g.projects)
  if (seededProject) commit({ project: seededProject })
  if (Object.keys(state.config ?? {}).length === 0 && Object.keys(g.config ?? {}).length > 0) {
    if (commit({ config: g.config })) emitSyncConfigChanged(directory, g.config)
  }
  if (loading) commit({ status: "partial" })
  if (input.isStale?.()) return "stale"

  // ---------------------------------------------------------------------------
  // Phase 1: Critical path — block until these resolve so the UI can render.
  // These are the minimum data needed to show a functional chat interface.
  // ---------------------------------------------------------------------------
  const phase1Results = await Promise.allSettled([
    retry(() =>
      opencodeClient.getLocation(directory).then((location) => {
        commit({
          project: location.project.id,
          path: { directory: location.directory, worktree: location.project.directory, home: g.path.home },
        })
      }),
    ),
    retry(() =>
      opencodeClient.getConfig(directory).then((config) => {
        if (commit({ config })) emitSyncConfigChanged(directory, config)
      }),
    ),
    retry(async () => {
      const statuses = await opencodeClient.getActiveSessionStatuses()
      if (statuses === null) throw new Error("session.active failed")
      commit({ session_status: statuses, sessionStatusReady: true })
    }),
  ])

  if (input.isStale?.()) return "stale"

  const phase1Errors = phase1Results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason)

  // De-block the UI: only a total failure (OpenCode genuinely unreachable)
  // should abort the directory. Don't let one transient initial fetch strand
  // the directory in "loading" forever and skip phase 2/3 (sessions).
  //   - session.active is LIVE data the event pipeline keeps current — a failed
  //     initial snapshot is harmless; the stream will deliver the real status.
  //   - location feeds project resolution, but if we already resolved a project
  //     (from global projects) its failure is tolerable.
  const [locationResult] = phase1Results
  const locationFailedWithoutProject = locationResult.status === "rejected" && !getState().project

  if (phase1Errors.length === phase1Results.length || locationFailedWithoutProject) {
    console.error(`[bootstrap] directory bootstrap failed for ${directory}`, phase1Errors[0])
    return "failed"
  }

  // Mark ready after critical data arrives so the UI can paint.
  if (loading) commit({ status: "complete" })

  // ---------------------------------------------------------------------------
  // Phase 2: Deferrable — fetch after first paint without blocking.
  // These enrich the UI but aren't required for basic functionality.
  // ---------------------------------------------------------------------------
  const runDeferredPhase = () => Promise.allSettled([
    retry(() => opencodeClient.listCommands(directory).then((command) => commit({ command }))),
    retry(() =>
      opencodeClient.listMcpServers(directory).then((servers) => {
        commit({ mcp: Object.fromEntries(servers.map((server) => [server.name, server])) })
      }),
    ),
    retry(() => opencodeClient.getVcs(directory).then((vcs) => commit({ vcs }))),
    retry(async () => {
      const before = getState()
      const forms: FormRequest[] = await opencodeClient.listPendingForms({ directories: [directory] })
      const current = getState()
      commit({ form: reconcilePendingRequests(before.form ?? {}, current.form, forms) })
    }),
    retry(async () => {
      const before = getState()
      const permissions: PermissionRequest[] = await opencodeClient.listPendingPermissions({ directories: [directory] })
      const current = getState()
      commit({ permission: reconcilePendingRequests(before.permission ?? {}, current.permission, permissions) })
    }),
  ]).then((results) => {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason)
    if (errors.length) {
      console.error(`[bootstrap] deferred phase failed for ${directory}`, errors[0])
    }
  })

  // ---------------------------------------------------------------------------
  // Phase 3: Authoritative session list. Keep this scheduler-owned so bounded
  // bootstrap concurrency also bounds list pagination, but do not hold the slot
  // for the deferrable enrichment phase above.
  // ---------------------------------------------------------------------------
  const sessionsResult = await Promise.allSettled([Promise.resolve(input.loadSessions(directory))])
  if (input.isStale?.()) return "stale"
  const sessionLoad = sessionsResult[0]
  setTimeout(() => {
    if (!input.isStale?.()) void runDeferredPhase()
  }, 0)
  if (sessionLoad?.status === "rejected") {
    console.error(`[bootstrap] session load failed for ${directory}`, sessionLoad.reason)
    return "failed"
  }
  return "complete"
}
