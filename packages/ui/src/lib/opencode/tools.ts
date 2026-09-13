/**
 * The tools OpenCode v2 ships, and the only place chat rendering is allowed to
 * branch on a tool name.
 *
 * v2 renamed and reshaped the built-ins: `bash` became `shell`, `task` became
 * `subagent`, `apply_patch` became `patch`, and `todowrite`, `todoread`, `lsp`,
 * `multiedit` and `list` are gone. File tools take `path` (not `filePath`), and
 * a tool state no longer carries a server-rendered `title` — the row's
 * description has to be derived from the call's own input and metadata.
 *
 * Everything outside this module works with the predicates and accessors here,
 * so the next rename is one file. Names that are not in this list (MCP servers,
 * OpenChamber's own plugin tools) still flow through the generic renderers;
 * every helper answers "no"/"unknown" for them instead of throwing.
 *
 * A call's `input` and `metadata` are free-form JSON the model and the tool
 * produced, so every read here parses the fields it claims to understand and
 * ignores the rest: one malformed field must not blank a whole tool row.
 */

import { z } from "zod"

import type { Metadata, ToolInput } from "./model"

/** Built-in tool names as the server reports them. */
export const OPENCODE_TOOLS = {
  edit: "edit",
  glob: "glob",
  grep: "grep",
  patch: "patch",
  question: "question",
  read: "read",
  shell: "shell",
  skill: "skill",
  subagent: "subagent",
  webfetch: "webfetch",
  websearch: "websearch",
  write: "write",
} as const

type OpencodeToolName = (typeof OPENCODE_TOOLS)[keyof typeof OPENCODE_TOOLS]

/** A tool name as it arrives on a part: always a string, sometimes namespaced. */
export type ToolName = string | undefined

/**
 * Comparable form of a tool name: lowercased, without a trailing `:index`
 * dedup suffix, and reduced to the last segment of a namespaced name
 * (`opencode.session_rename` -> `session_rename`).
 */
export function normalizeToolName(toolName: ToolName): string {
  const trimmed = toolName?.trim().toLowerCase()
  if (!trimmed) return ""
  const withoutIndex = trimmed.replace(/:\d+$/, "")
  if (!withoutIndex.includes(".")) return withoutIndex
  const segments = withoutIndex.split(".").filter(Boolean)
  return segments[segments.length - 1] ?? withoutIndex
}

const is = (name: OpencodeToolName) => (toolName: ToolName): boolean => normalizeToolName(toolName) === name

export const isShellTool = is(OPENCODE_TOOLS.shell)
export const isSubagentTool = is(OPENCODE_TOOLS.subagent)
export const isQuestionTool = is(OPENCODE_TOOLS.question)
export const isSkillTool = is(OPENCODE_TOOLS.skill)
export const isReadTool = is(OPENCODE_TOOLS.read)
const isGlobTool = is(OPENCODE_TOOLS.glob)
export const isEditTool = is(OPENCODE_TOOLS.edit)
export const isWriteTool = is(OPENCODE_TOOLS.write)
export const isPatchTool = is(OPENCODE_TOOLS.patch)
const isWebFetchTool = is(OPENCODE_TOOLS.webfetch)
const isWebSearchTool = is(OPENCODE_TOOLS.websearch)

const FILE_CHANGE_TOOLS = new Set<string>([OPENCODE_TOOLS.edit, OPENCODE_TOOLS.write, OPENCODE_TOOLS.patch])
const EXPLORATION_TOOLS = new Set<string>([
  OPENCODE_TOOLS.read,
  OPENCODE_TOOLS.grep,
  OPENCODE_TOOLS.glob,
  OPENCODE_TOOLS.skill,
])
const WEB_TOOLS = new Set<string>([OPENCODE_TOOLS.webfetch, OPENCODE_TOOLS.websearch])

/** Tools that mutate a file, so a turn counts their result as a change. */
export const isFileChangeTool = (toolName: ToolName): boolean => FILE_CHANGE_TOOLS.has(normalizeToolName(toolName))

/** Tools whose result metadata carries `files: FileDiff.Info[]`. */
export const carriesFileDiffs = (toolName: ToolName): boolean => {
  const name = normalizeToolName(toolName)
  return name === OPENCODE_TOOLS.edit || name === OPENCODE_TOOLS.patch
}

export const isExplorationTool = (toolName: ToolName): boolean => EXPLORATION_TOOLS.has(normalizeToolName(toolName))
export const isWebTool = (toolName: ToolName): boolean => WEB_TOOLS.has(normalizeToolName(toolName))

/**
 * Tools that block the turn on a form the user must answer. Only `question`
 * does this today; the form itself renders as its own card.
 */
export const blocksOnForm = isQuestionTool

// ---------------------------------------------------------------------------
// Input and metadata accessors
// ---------------------------------------------------------------------------

const optionalText = z.string().trim().min(1).optional().catch(undefined)
const optionalCount = z.number().int().nonnegative().optional().catch(undefined)

const inputSchema = z
  .object({
    // v2 file tools use `path`; the other two keep MCP and plugin tools that
    // use the older naming working.
    path: optionalText,
    filePath: optionalText,
    file_path: optionalText,
    command: optionalText,
    description: optionalText,
    agent: optionalText,
    name: optionalText,
    pattern: optionalText,
    query: optionalText,
    url: optionalText,
    questions: z.array(z.unknown()).optional().catch(undefined),
  })
  .catch({})

const fileDiffSchema = z.object({
  file: optionalText,
  patch: optionalText,
  additions: optionalCount,
  deletions: optionalCount,
  status: z.enum(["added", "deleted", "modified"]).optional().catch(undefined),
})

const metadataSchema = z
  .object({
    files: z.array(fileDiffSchema.nullable().catch(null)).optional().catch(undefined),
    sessionID: optionalText,
    sessionId: optionalText,
    name: optionalText,
  })
  .catch({})

type ParsedInput = z.infer<typeof inputSchema>

const readInput = (input: ToolInput | undefined): ParsedInput => inputSchema.parse(input ?? {})

/** One entry of a tool's `metadata.files` (`FileDiff.Info` on the wire). */
export type ToolFileDiff = z.infer<typeof fileDiffSchema> & { file: string }

/**
 * The file a call targets, as the tool reported it. Callers render it relative
 * to the session directory.
 */
export function toolInputPath(input: ToolInput | undefined): string | undefined {
  const parsed = readInput(input)
  return parsed.path ?? parsed.filePath ?? parsed.file_path
}

function toolInputCommand(input: ToolInput | undefined): string | undefined {
  return readInput(input).command
}

/**
 * Per-file diffs a completed `edit` or `patch` call reported. Entries without
 * a file are dropped rather than failing the whole list, so one malformed file
 * cannot erase the other files of the same call.
 */
export function toolFileDiffs(metadata: Metadata | undefined): ToolFileDiff[] {
  const files = metadataSchema.parse(metadata ?? {}).files ?? []
  return files.filter((entry): entry is ToolFileDiff => entry !== null && entry.file !== undefined)
}

/** The child session a `subagent` call runs in (`metadata.sessionID`). */
export function subagentSessionId(metadata: Metadata | undefined): string | undefined {
  const parsed = metadataSchema.parse(metadata ?? {})
  return parsed.sessionID ?? parsed.sessionId
}

// ---------------------------------------------------------------------------
// Row description
// ---------------------------------------------------------------------------

/**
 * What a tool row shows under the tool name.
 *
 * `path` results are raw paths the caller still renders relative to the
 * session directory (and with a file icon); `text` results are shown as is.
 */
/**
 * What a tool row says under its name. `path`/`text` come straight from the
 * call; `questions`/`files` are counts the UI turns into localized copy.
 */
export type ToolDescription =
  | { kind: "path"; value: string }
  | { kind: "text"; value: string }
  | { kind: "questions"; count: number }
  | { kind: "files"; count: number }

const MAX_COMMAND_LENGTH = 100
const MAX_TEXT_LENGTH = 120

const text = (value: string | undefined): ToolDescription | null =>
  value ? { kind: "text", value: value.slice(0, MAX_TEXT_LENGTH) } : null

const asPath = (value: string | undefined): ToolDescription | null => (value ? { kind: "path", value } : null)

/**
 * Derives the row description from v2 data alone: no state carries a title any
 * more, so every tool answers from its own input, falling back to the per-tool
 * result metadata and finally to a generic `description` field for MCP tools.
 */
export function toolDescription(
  toolName: ToolName,
  input: ToolInput | undefined,
  metadata: Metadata | undefined,
): ToolDescription | null {
  const name = normalizeToolName(toolName)
  const parsed = readInput(input)

  switch (name) {
    case OPENCODE_TOOLS.shell:
      return parsed.command ? { kind: "text", value: parsed.command.split("\n")[0].slice(0, MAX_COMMAND_LENGTH) } : null

    // "A short 3-5 word label for the task, displayed to the user".
    case OPENCODE_TOOLS.subagent:
      return text(parsed.description) ?? text(parsed.agent)

    case OPENCODE_TOOLS.patch: {
      const files = toolFileDiffs(metadata)
      if (files.length > 1) return { kind: "files", count: files.length }
      return asPath(files[0]?.file)
    }

    case OPENCODE_TOOLS.edit:
    case OPENCODE_TOOLS.write:
    case OPENCODE_TOOLS.read:
      return asPath(parsed.path ?? parsed.filePath ?? parsed.file_path ?? toolFileDiffs(metadata)[0]?.file)

    case OPENCODE_TOOLS.grep:
    case OPENCODE_TOOLS.glob:
      return text(parsed.pattern)

    case OPENCODE_TOOLS.webfetch:
      return text(parsed.url)

    case OPENCODE_TOOLS.websearch:
      return text(parsed.query)

    case OPENCODE_TOOLS.skill:
      return text(parsed.name) ?? text(metadataSchema.parse(metadata ?? {}).name)

    case OPENCODE_TOOLS.question: {
      const count = parsed.questions?.length ?? 0
      return count > 0 ? { kind: "questions", count } : null
    }

    // MCP and plugin tools: anything they call a description, then a path.
    default:
      return text(parsed.description) ?? asPath(parsed.path ?? parsed.filePath ?? parsed.file_path)
  }
}
