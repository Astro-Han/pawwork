import { type ChildProcess } from "child_process"
import launch from "cross-spawn"
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { buffer } from "node:stream/consumers"
import { setTimeout as sleep } from "node:timers/promises"
import { errorMessage } from "./error"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "util.process" })

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

  export interface Interface {
    readonly spawn: (cmd: string[], opts?: Options) => Effect.Effect<Child, unknown>
    readonly run: (cmd: string[], opts?: RunOptions) => Effect.Effect<Result, unknown>
    readonly text: (cmd: string[], opts?: RunOptions) => Effect.Effect<TextResult, unknown>
    readonly lines: (cmd: string[], opts?: RunOptions) => Effect.Effect<string[], unknown>
    readonly stop: (proc: ChildProcess) => Effect.Effect<void, unknown>
    readonly descendants: (pid: number) => Effect.Effect<number[]>
    readonly terminateTree: (input: TerminateTreeInput) => Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Process") {}

  export interface TerminateTreeInput {
    pid: number
    graceMs?: number
    signalRoot?: (signal: NodeJS.Signals) => void
    waitForExit?: Promise<unknown>
    findDescendants?: (pid: number) => Promise<number[]>
  }

  function spawnNode(cmd: string[], opts: Options = {}): Child {
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
    let exited: Promise<number>

    const abort = () => {
      if (closed) return
      if (proc.exitCode !== null || proc.signalCode !== null) return
      closed = true

      const ms = opts.timeout ?? 5_000
      if (ms <= 0) {
        proc.kill(opts.kill ?? "SIGTERM")
        return
      }
      if (!proc.pid) {
        proc.kill(opts.kill ?? "SIGTERM")
        return
      }

      void terminateTree({
        pid: proc.pid,
        graceMs: ms,
        signalRoot: (signal) => proc.kill(signal),
        waitForExit: exited,
      }).catch((error) => {
        log.debug("failed to terminate aborted process tree", { pid: proc.pid, error: errorMessage(error) })
        proc.kill("SIGKILL")
      })
    }

    exited = new Promise<number>((resolve, reject) => {
      const done = () => {
        opts.abort?.removeEventListener("abort", abort)
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

  export function spawn(cmd: string[], opts: Options = {}): Child {
    return spawnNode(cmd, opts)
  }

  export const spawnEffect = Effect.fn("Process.spawn")(function* (cmd: string[], opts: Options = {}) {
    return yield* Effect.sync(() => spawnNode(cmd, opts))
  })

  export const runEffect = Effect.fn("Process.run")(function* (cmd: string[], opts: RunOptions = {}) {
    const proc = yield* spawnEffect(cmd, {
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

    if (!proc.stdout || !proc.stderr) return yield* Effect.fail(new Error("Process output not available"))

    const out = yield* Effect.tryPromise(() =>
      Promise.all([proc.exited, buffer(proc.stdout!), buffer(proc.stderr!)]).then(([code, stdout, stderr]) => ({
        code,
        stdout,
        stderr,
      })),
    ).pipe(
      Effect.catch((err: unknown) => {
        if (!opts.nothrow) return Effect.fail(err)
        return Effect.succeed({
          code: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(errorMessage(err)),
        })
      }),
    )
    if (out.code === 0 || opts.nothrow) return out
    return yield* Effect.fail(new RunFailedError(cmd, out.code, out.stdout, out.stderr))
  })

  // The SDK keeps a sync stop variant because it cannot import opencode without
  // creating a cycle. Keep platform behavior aligned when changing this path.
  export const stopEffect = Effect.fn("Process.stop")(function* (proc: ChildProcess) {
    if (proc.exitCode !== null || proc.signalCode !== null) return

    if (!proc.pid) {
      proc.kill()
      return
    }

    const waitForExit = new Promise<void>((resolve) => {
      const done = () => {
        proc.off("exit", done)
        proc.off("error", done)
        resolve()
      }
      proc.once("exit", done)
      proc.once("error", done)
    })

    yield* terminateTreeEffect({
      pid: proc.pid,
      signalRoot: (signal) => proc.kill(signal),
      waitForExit,
    })
  })

  export function exists(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  export const descendantsEffect = Effect.fn("Process.descendants")(function* (pid: number) {
    if (process.platform === "win32") return []
    const seen = new Set<number>()
    const pending = [pid]
    while (pending.length) {
      const parent = pending.pop()!
      const out = yield* textEffect(["pgrep", "-P", String(parent)], { nothrow: true }).pipe(
        Effect.map((result) => result.text),
        Effect.catch((error) => {
          log.debug("failed to enumerate child processes", { pid: parent, error: errorMessage(error) })
          return Effect.succeed("")
        }),
      )
      for (const line of out.split(/\s+/)) {
        const child = Number(line)
        if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
        seen.add(child)
        pending.push(child)
      }
    }
    return Array.from(seen)
  })

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

  export const terminateTreeEffect = Effect.fn("Process.terminateTree")(function* (input: TerminateTreeInput) {
    const graceMs = input.graceMs ?? TERMINATION_GRACE_MS
    if (process.platform === "win32") {
      yield* runEffect(["taskkill", "/pid", String(input.pid), "/f", "/t"], { nothrow: true })
      return
    }

    // Descendants are a best-effort snapshot for normal child processes. A
    // daemonized double-fork can intentionally leave this tree before cleanup.
    const children = yield* (
      input.findDescendants
        ? Effect.tryPromise(() => input.findDescendants!(input.pid))
        : descendantsEffect(input.pid)
    ).pipe(
      Effect.catch((error) => {
        log.debug("failed to enumerate process tree", { pid: input.pid, error: errorMessage(error) })
        return Effect.succeed([])
      }),
    )
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
    log.debug("sent process tree terminate signal", { pid: input.pid, groupSignaled, descendantCount: children.length })
    if (!groupSignaled) {
      signalRoot("SIGTERM")
      for (const child of children) signalPid(child, "SIGTERM")
    }

    // With waitForExit, worst case is one grace period before SIGKILL and one
    // bounded wait after SIGKILL so callers can observe the final exit.
    const rootExited = yield* Effect.promise(() =>
      input.waitForExit
        ? Promise.race([input.waitForExit.then(() => true, () => true), sleep(graceMs).then(() => false)])
        : sleep(graceMs).then(() => false),
    )

    if (!exists(input.pid) && children.every((child) => !exists(child))) return
    if (groupSignaled && !rootExited && exists(input.pid)) {
      signalGroup(input.pid, "SIGKILL")
      log.debug("sent process group kill signal", { pid: input.pid })
    } else {
      signalRoot("SIGKILL")
    }
    for (const child of children) signalPid(child, "SIGKILL")
    log.debug("sent process tree kill signals", { pid: input.pid, groupSignaled, descendantCount: children.length })
    if (input.waitForExit) yield* Effect.promise(() => Promise.race([input.waitForExit!.catch(() => undefined), sleep(graceMs)]))
  })

  export const textEffect = Effect.fn("Process.text")(function* (cmd: string[], opts: RunOptions = {}) {
    const out = yield* runEffect(cmd, opts)
    return {
      ...out,
      text: out.stdout.toString(),
    }
  })

  export const linesEffect = Effect.fn("Process.lines")(function* (cmd: string[], opts: RunOptions = {}) {
    return (yield* textEffect(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
  })

  export const layer = Layer.succeed(
    Service,
    Service.of({
      spawn: spawnEffect,
      run: runEffect,
      text: textEffect,
      lines: linesEffect,
      stop: stopEffect,
      descendants: descendantsEffect,
      terminateTree: terminateTreeEffect,
    }),
  )
  export const defaultLayer = layer

  const runtime = ManagedRuntime.make(defaultLayer)
  const runPromise = <A, E>(fn: (process: Interface) => Effect.Effect<A, E>) => runtime.runPromise(Service.use(fn))

  export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
    return runPromise((process) => process.run(cmd, opts))
  }

  export async function stop(proc: ChildProcess) {
    return runPromise((process) => process.stop(proc))
  }

  export async function descendants(pid: number): Promise<number[]> {
    return runPromise((process) => process.descendants(pid))
  }

  export async function terminateTree(input: TerminateTreeInput) {
    return runPromise((process) => process.terminateTree(input))
  }

  export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
    return runPromise((process) => process.text(cmd, opts))
  }

  export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
    return runPromise((process) => process.lines(cmd, opts))
  }
}
