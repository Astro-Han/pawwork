// Single source for invariant-breach reporting. Sync throw is exposed via
// assertCommandTextPart for helpers; this reporter is the renderer/submit
// boundary that may run inside a render pass where throwing would break UI.

import { showToast } from "@opencode-ai/ui/toast"

// Guard flag: only show the recovery toast once per app session so the user
// is not spammed if the same invariant fires on every render.
let prodToastShown = false

function isDev(): boolean {
  try {
    return (import.meta as any).env?.DEV === true
  } catch {
    return false
  }
}

export function reportInvariantBreach(message: string, context: unknown): void {
  if (isDev()) {
    // Re-raise asynchronously so the renderer pass does not crash; Vite's
    // unhandled-rejection overlay and Bun's reporter both surface it.
    queueMicrotask(() => {
      throw new Error(`invariant breach: ${message} — context: ${JSON.stringify(context)}`)
    })
    return
  }
  // Prod: silently self-heal (caller continues with degraded state) and show
  // a one-time non-blocking toast so users know something was recovered.
  if (prodToastShown) return
  prodToastShown = true
  showToast({
    title: "Command formatting recovered",
    description: "Please report if this happens repeatedly.",
    variant: "subtle",
  })
}
