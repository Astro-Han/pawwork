import type { Part } from "@opencode-ai/sdk/v2"

export const taskDescription = (part: Part, sessionID: string) => {
  if (part.type !== "tool" || (part.tool !== "task" && part.tool !== "agent")) return // agent-rename:legacy-render
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}
