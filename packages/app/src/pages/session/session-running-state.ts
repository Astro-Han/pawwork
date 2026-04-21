import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"

const idle = { type: "idle" as const }

/** Status is authoritative; when idle, only the latest message can indicate in-flight work. */
export function isSessionRunning(status: SessionStatus | undefined, messages: readonly Message[] | undefined): boolean {
  if ((status ?? idle).type !== "idle") return true

  const latest = messages?.at(-1)
  return latest?.role === "assistant" && typeof latest.time?.completed !== "number"
}
