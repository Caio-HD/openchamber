import { z } from "zod"

// v2 reports active loops globally. A malformed response cannot prove idle.
export const activeSessionSnapshotSchema = z.record(z.string().min(1), z.object({ type: z.literal("running") }))
