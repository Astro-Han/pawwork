export function shouldShowLayoutDebugBar() {
  if (!import.meta.env.DEV) return false
  if (typeof window === "undefined") return false
  return !((window as typeof window & { __opencode_e2e?: unknown }).__opencode_e2e)
}
