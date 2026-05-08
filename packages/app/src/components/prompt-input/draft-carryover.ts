import { createSignal } from "solid-js"

export interface DraftSnapshot {
  text: string
}

const [lastTouched, setLastTouched] = createSignal<{ directory: string; snapshot: DraftSnapshot } | null>(null)

export function recordDraftEdit(directory: string, snapshot: DraftSnapshot) {
  if (!directory) return
  if (!snapshot.text) {
    if (lastTouched()?.directory === directory) setLastTouched(null)
    return
  }
  setLastTouched({ directory, snapshot })
}

export function consumeCarryOver(targetDirectory: string, targetIsEmpty: boolean): DraftSnapshot | null {
  const current = lastTouched()
  if (!current) return null
  if (current.directory === targetDirectory) return null
  if (!targetIsEmpty) return null
  setLastTouched(null)
  return current.snapshot
}

export function clearCarryOver() {
  setLastTouched(null)
}

export const _peekLastTouched = () => lastTouched()
