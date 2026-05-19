import type { Message, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { isWorkInFlightStatus } from "@opencode-ai/ui/util/session-status"

const idle = { type: "idle" as const }
// Server status should arrive quickly after a message is created. A longer window keeps stale turns visually active longer.
export const PENDING_MESSAGE_FALLBACK_MS = 30_000

/** Status is authoritative; when idle, only the latest message can indicate in-flight work. */
export function isSessionRunning(
  status: SessionStatus | undefined,
  messages: readonly Message[] | undefined,
  options: { now?: number } = {},
): boolean {
  if (isWorkInFlightStatus(status)) return true

  return runningFallbackExpiresAt(status, messages, options) !== undefined
}

/** Returns undefined when the latest-message fallback is inactive, regardless of why. */
export function runningFallbackExpiresAt(
  status: SessionStatus | undefined,
  messages: readonly Message[] | undefined,
  options: { now?: number } = {},
): number | undefined {
  if (isWorkInFlightStatus(status)) return

  const latest = messages?.at(-1)
  if (latest?.role !== "assistant") return
  if (typeof latest.time?.completed === "number") return
  const created = latest.time?.created
  if (typeof created !== "number") return

  const now = options.now ?? Date.now()
  const expiresAt = created + PENDING_MESSAGE_FALLBACK_MS
  return expiresAt > now ? expiresAt : undefined
}

export function createSessionRunning(
  status: Accessor<SessionStatus | undefined>,
  messages: Accessor<readonly Message[] | undefined>,
): Accessor<boolean> {
  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  createEffect(() => {
    const currentStatus = status()
    const currentMessages = messages()
    const currentNow = Date.now()

    clearTimer()

    const expiresAt = runningFallbackExpiresAt(currentStatus, currentMessages, { now: currentNow })
    if (expiresAt === undefined) return

    timer = setTimeout(() => {
      timer = undefined
      setTick((value) => value + 1)
    }, Math.max(0, expiresAt - currentNow) + 10)
  })

  onCleanup(clearTimer)

  return createMemo(() => {
    tick()
    return isSessionRunning(status(), messages())
  })
}
