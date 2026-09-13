import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { FormRequest, Project } from "@/lib/opencode/model"
import { INITIAL_STATE, type State } from "./types"

type ClientStub = {
  getLocation: () => Promise<{ directory: string; project: { id: string; directory: string; canonical: string } }>
  getConfig: () => Promise<Record<string, never>>
  getActiveSessionStatuses: () => Promise<State["session_status"] | null>
  listCommands: () => Promise<unknown[]>
  listMcpServers: () => Promise<unknown[]>
  getVcs: () => Promise<{ branch: string }>
  listPendingForms: () => Promise<FormRequest[]>
  listPendingPermissions: () => Promise<unknown[]>
  getFilesystemHome: () => Promise<string>
  listProjects: () => Promise<Project[]>
}

const client: ClientStub = {
  getLocation: async () => ({ directory: "/repo", project: { id: "project-a", directory: "/repo", canonical: "/repo" } }),
  getConfig: async () => ({}),
  getActiveSessionStatuses: async () => ({}),
  listCommands: async () => [],
  listMcpServers: async () => [],
  getVcs: async () => ({ branch: "main" }),
  listPendingForms: async () => [],
  listPendingPermissions: async () => [],
  getFilesystemHome: async () => "/home",
  listProjects: async () => [],
}

;(mock as unknown as { restore?: () => void }).restore?.()
mock.module("@/lib/opencode/client", () => ({ opencodeClient: client }))
mock.module("../lib/chatDirectories", () => ({ warmChatsRootDirectory: async () => undefined }))
mock.module("../lib/runtime-fetch", () => ({ runtimeFetch: async () => new Response("{}", { status: 200 }) }))

const { bootstrapDirectory } = await import(`./bootstrap?bootstrap-test=${Date.now()}`)

const createState = (): State => ({ ...INITIAL_STATE, message: {}, part: {} })

const project: Project = {
  id: "project-a",
  worktree: "/repo",
  time: { created: 1, updated: 1 },
  sandboxes: [],
}

const form = (id: string, sessionID: string, title = "Pick"): FormRequest => ({
  id,
  sessionID,
  title,
  fields: [{ key: "a", type: "boolean" }],
})

const run = (state: { current: State }, loadSessions: () => Promise<void> | void = async () => undefined) =>
  bootstrapDirectory({
    directory: "/repo",
    getState: () => state.current,
    set: (patch: Partial<State>) => {
      state.current = { ...state.current, ...patch }
    },
    global: { config: {}, projects: [project], path: { directory: "", worktree: "", home: "/home" } },
    loadSessions,
  })

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  client.listCommands = async () => []
  client.listPendingForms = async () => []
  client.getActiveSessionStatuses = async () => ({})
})

describe("bootstrapDirectory", () => {
  test("prioritizes session loading without waiting for deferred fields", async () => {
    const state = { current: createState() }
    let deferredStarted = false
    let resolveDeferred!: () => void
    const deferred = new Promise<unknown[]>((resolve) => {
      resolveDeferred = () => resolve([])
    })
    let resolveSessions!: () => void
    const sessions = new Promise<void>((resolve) => {
      resolveSessions = resolve
    })
    let settled = false
    client.listCommands = async () => {
      deferredStarted = true
      return deferred
    }
    const bootstrapping = run(state, () => sessions).then((result: string) => {
      settled = true
      return result
    })

    await tick()
    expect(deferredStarted).toBe(false)
    expect(settled).toBe(false)
    expect(state.current.status).toBe("complete")
    expect(state.current.project).toBe("project-a")
    expect(state.current.path).toEqual({ directory: "/repo", worktree: "/repo", home: "/home" })

    resolveSessions()
    expect(await bootstrapping).toBe("complete")
    await tick()
    expect(deferredStarted).toBe(true)
    resolveDeferred()
  })

  test("a failed status snapshot leaves the prior status untouched", async () => {
    const state = { current: { ...createState(), session_status: { ses_1: { type: "busy" as const } } } }
    client.getActiveSessionStatuses = async () => null
    expect(await run(state)).toBe("complete")
    expect(state.current.session_status).toEqual({ ses_1: { type: "busy" } })
    expect(state.current.sessionStatusReady).toBeUndefined()
  })

  test("deferred phase merges fetched forms by session, replacing the pre-fetch record", async () => {
    const state = { current: { ...createState(), form: { ses_1: [form("form_1", "ses_1")] } } }
    const fetched = [form("form_2", "ses_1"), form("form_1", "ses_1", "Updated")]
    client.listPendingForms = async () => fetched

    await run(state)
    await tick()

    expect(state.current.form.ses_1?.map((f) => f.id)).toEqual(["form_1", "form_2"])
    expect(state.current.form.ses_1?.[0]?.title).toBe("Updated")
  })

  test("deferred phase deletes a session's forms when they disappear and nothing changed meanwhile", async () => {
    const state = { current: { ...createState(), form: { ses_1: [form("form_1", "ses_1")], ses_2: [form("form_3", "ses_2")] } } }
    client.listPendingForms = async () => []

    await run(state)
    await tick()

    expect(state.current.form).toEqual({})
  })

  test("deferred phase preserves in-flight form changes when the signature changed", async () => {
    const state = { current: { ...createState(), form: { ses_1: [form("form_1", "ses_1")] } } }
    client.listPendingForms = async () => {
      // A live event lands while the fetch is in flight.
      state.current = { ...state.current, form: { ...state.current.form, ses_1: [form("form_1", "ses_1"), form("form_2", "ses_1")] } }
      return []
    }

    await run(state)
    await tick()

    expect(state.current.form.ses_1?.map((f) => f.id)).toEqual(["form_1", "form_2"])
  })
})
