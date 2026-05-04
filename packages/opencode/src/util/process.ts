import { type ChildProcess } from "child_process"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage } from "./error"

export namespace Process {
  export const TERMINATION_GRACE_MS = 500

  export type Stdio = "inherit" | "pipe" | "ignore"
  export type Shell = boolean | string

  export interface Options {
    cwd?: string
    env?: NodeJS.ProcessEnv | null
    stdin?: Stdio
    stdout?: Stdio
    stderr?: Stdio
    shell?: Shell
    abort?: AbortSignal
    kill?: NodeJS.Signals | number
    timeout?: number
  }

  export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
    nothrow?: boolean
  }

  export interface Result {
    code: number
    stdout: Buffer
    stderr: Buffer
  }

  export interface TextResult extends Result {
    text: string
  }

  export class RunFailedError extends Error {
    readonly cmd: string[]
    readonly code: number
    readonly stdout: Buffer
    readonly stderr: Buffer

    constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
      const text = stderr.toString().trim()
      super(
        text
          ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
          : `Command failed with code ${code}: ${cmd.join(" ")}`,
      )
      this.name = "ProcessRunFailedError"
      this.cmd = [...cmd]
      this.code = code
      this.stdout = stdout
      this.stderr = stderr
    }
  }

  export type Child = ChildProcess & { exited: Promise<number> }

  export function spawn(cmd: string[], opts: Options = {}): Child {
    if (cmd.length === 0) throw new Error("Command is required")
    opts.abort?.throwIfAborted()

    const proc = launch(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      shell: opts.shell,
      env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
      stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
      windowsHide: process.platform === "win32",
    })

    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const abort = () => {
      if (closed) return
      if (proc.exitCode !== null || proc.signalCode !== null) return
      closed = true

      proc.kill(opts.kill ?? "SIGTERM")

      const ms = opts.timeout ?? 5_000
      if (ms <= 0) return
      timer = setTimeout(() => proc.kill("SIGKILL"), ms)
    }

    const exited = new Promise<number>((resolve, reject) => {
      const done = () => {
        opts.abort?.removeEventListener("abort", abort)
        if (timer) clearTimeout(timer)
      }

      proc.once("exit", (code, signal) => {
        done()
        resolve(code ?? (signal ? 1 : 0))
      })

      proc.once("error", (error) => {
        done()
        reject(error)
      })
    })
    void exited.catch(() => undefined)

    if (opts.abort) {
      opts.abort.addEventListener("abort", abort, { once: true })
      if (opts.abort.aborted) abort()
    }

    const child = proc as Child
    child.exited = exited
    return child
  }

  export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
    const proc = spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin,
      shell: opts.shell,
      abort: opts.abort,
      kill: opts.kill,
      timeout: opts.timeout,
      stdout: "pipe",
      stderr: "pipe",
    })

    if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")

    const out = await Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
      .then(([code, stdout, stderr]) => ({
        code,
        stdout,
        stderr,
      }))
      .catch((err: unknown) => {
        if (!opts.nothrow) throw err
        return {
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(errorMessage(err)),
        }
      })
    if (out.code === 0 || opts.nothrow) return out
    throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
  }

  // Duplicated in `packages/sdk/js/src/process.ts` because the SDK cannot import
  // `opencode` without creating a cycle. Keep both copies in sync.
  export async function stop(proc: ChildProcess) {
    if (proc.exitCode !== null || proc.signalCode !== null) return

    if (process.platform !== "win32" || !proc.pid) {
      proc.kill()
      return
    }

    const out = await run(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
      nothrow: true,
    })

    if (out.code === 0) return
    proc.kill()
  }

  export function exists(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  export async function descendants(pid: number): Promise<number[]> {
    if (process.platform === "win32") return []
    const seen = new Set<number>()
    const pending = [pid]
    while (pending.length) {
      const parent = pending.pop()!
      const out = await Bun.$`pgrep -P ${parent}`.quiet().nothrow().text()
      for (const line of out.split(/\s+/)) {
        const child = Number(line)
        if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
        seen.add(child)
        pending.push(child)
      }
    }
    return Array.from(seen)
  }

  function signalPid(pid: number, signal: NodeJS.Signals) {
    try {
      if (exists(pid)) process.kill(pid, signal)
      return true
    } catch {
      return false
    }
  }

  function signalGroup(pid: number, signal: NodeJS.Signals) {
    try {
      process.kill(-pid, signal)
      return true
    } catch {
      return false
    }
  }

  export async function terminateTree(input: {
    pid: number
    graceMs?: number
    signalRoot?: (signal: NodeJS.Signals) => void
    waitForExit?: Promise<unknown>
  }) {
    const graceMs = input.graceMs ?? TERMINATION_GRACE_MS
    if (process.platform === "win32") {
      await Bun.$`taskkill /pid ${input.pid} /f /t`.quiet().nothrow()
      return
    }

    const children = await descendants(input.pid)
    const signalRoot = (signal: NodeJS.Signals) => {
      if (input.signalRoot && exists(input.pid)) {
        try {
          input.signalRoot(signal)
          return
        } catch {}
      }
      signalPid(input.pid, signal)
    }

    const groupSignaled = signalGroup(input.pid, "SIGTERM")
    if (!groupSignaled) {
      signalRoot("SIGTERM")
      for (const child of children) signalPid(child, "SIGTERM")
    }

    const rootExited = await (input.waitForExit
      ? Promise.race([input.waitForExit.then(() => true), sleep(graceMs).then(() => false)])
      : sleep(graceMs).then(() => false))

    if (!exists(input.pid) && children.every((child) => !exists(child))) return
    if (groupSignaled && !rootExited && exists(input.pid)) {
      signalGroup(input.pid, "SIGKILL")
      return
    }
    signalRoot("SIGKILL")
    for (const child of children) signalPid(child, "SIGKILL")
  }

  export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
    const out = await run(cmd, opts)
    return {
      ...out,
      text: out.stdout.toString(),
    }
  }

  export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
    return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
  }
}
