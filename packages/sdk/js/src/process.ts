import { type ChildProcess, spawnSync } from "node:child_process"

function descendants(pid: number) {
  if (process.platform === "win32") return []
  const seen = new Set<number>()
  const pending = [pid]
  while (pending.length) {
    const parent = pending.pop()!
    const out = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
    if (out.error || out.status !== 0) continue
    for (const line of out.stdout.split(/\s+/)) {
      const child = Number(line)
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
      seen.add(child)
      pending.push(child)
    }
  }
  return Array.from(seen)
}

function signal(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch {}
}

// Kept in sync with `packages/opencode/src/util/process.ts` without importing
// opencode, which depends on this SDK package.
export function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
    if (!out.error && out.status === 0) return
  }
  if (!proc.pid) {
    proc.kill()
    return
  }
  const children = descendants(proc.pid)
  signal(proc.pid, "SIGTERM")
  for (const child of children) signal(child, "SIGTERM")
  signal(proc.pid, "SIGKILL")
  for (const child of children) signal(child, "SIGKILL")
}

export function bindAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  if (!signal) return () => {}
  const abort = () => {
    clear()
    stop(proc)
    onAbort?.()
  }
  const clear = () => {
    signal.removeEventListener("abort", abort)
    proc.off("exit", clear)
    proc.off("error", clear)
  }
  signal.addEventListener("abort", abort, { once: true })
  proc.on("exit", clear)
  proc.on("error", clear)
  if (signal.aborted) abort()
  return clear
}
