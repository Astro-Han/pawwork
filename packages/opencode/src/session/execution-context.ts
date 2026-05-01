import z from "zod"

export const ActiveWorktree = z.object({
  directory: z.string(),
  name: z.string(),
  branch: z.string().optional(),
  source: z.enum(["created", "existing"]),
})
export type ActiveWorktree = z.infer<typeof ActiveWorktree>

export const SessionExecutionContext = z.object({
  ownerDirectory: z.string(),
  activeDirectory: z.string(),
  activeWorktree: ActiveWorktree.optional(),
  lastChangedAt: z.number(),
})
export type SessionExecutionContext = z.infer<typeof SessionExecutionContext>

export function rootContext(ownerDirectory: string): SessionExecutionContext {
  return {
    ownerDirectory,
    activeDirectory: ownerDirectory,
    lastChangedAt: Date.now(),
  }
}

export function isAtRoot(ctx: SessionExecutionContext): boolean {
  return ctx.activeDirectory === ctx.ownerDirectory && ctx.activeWorktree === undefined
}
