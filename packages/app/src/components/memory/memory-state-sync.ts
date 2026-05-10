import { createSignal } from "solid-js"

const [memoryStateVersion, setMemoryStateVersion] = createSignal(0)

export { memoryStateVersion }

export function notifyMemoryStateChanged() {
  setMemoryStateVersion((version) => version + 1)
}
