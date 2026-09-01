type DshReadableStream = {
  on(event: "data", listener: (data: Buffer | string) => void): unknown
  off(event: "data", listener: (data: Buffer | string) => void): unknown
}

export interface DshChildProcess {
  readonly stdout: DshReadableStream | null
  readonly stderr: DshReadableStream | null
  readonly pid?: number
  send(message: string): boolean
  kill(signal?: NodeJS.Signals | number): boolean
  // "error" is declared because it must be listened to, not because anything
  // here wants it: an EventEmitter with no "error" listener rethrows the event
  // as an uncaught exception, and in the main process that is the app dying
  // before any promise this module returns can settle.
  on(event: "exit", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "message", listener: (message: unknown) => void): this
  once(event: "exit", listener: (code: number | null) => void): this
  off(event: "exit", listener: (code: number | null) => void): this
  off(event: "message", listener: (message: unknown) => void): this
}

type SpawnDshProcess = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe", "ipc"] },
) => DshChildProcess

type LaunchDshSidecarOptions = {
  executable: string
  dshBin: string
  sidecarPreload: string
  productPatch: string
  env: NodeJS.ProcessEnv
  stopTimeoutMs?: number
  spawn: SpawnDshProcess
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  onError?: (error: Error) => void
}

export type DshRun = {
  ready: Promise<string>
  exited: Promise<number | null>
  stop(): Promise<void>
}

// Node reports a signal kill as a null code, so "code null" is what a plain
// interpolation puts in front of the user. It is not a status; say so.
export function describeExit(code: number | null) {
  return code === null ? "without a status code" : `with code ${code}`
}

const DEFAULT_STOP_TIMEOUT_MS = 5_000

/**
 * Readiness arrives as data on the IPC channel this spawn opens, sent by the
 * `pawwork-web-ready` plugin mounted inside the sidecar — which owns the
 * argument for why DSH's own `dsh web:` line is not an interface. The literal
 * is spelled independently on both sides so a rename on either fails a test
 * rather than hanging a launch.
 */
const WEB_READY_MESSAGE = "pawwork:web-ready"

/** The announced URL, or undefined for anything else the sidecar sends. */
function readyUrlOf(message: unknown) {
  if (typeof message !== "object" || message === null) return undefined
  const { type, url } = message as { type?: unknown; url?: unknown }
  if (type !== WEB_READY_MESSAGE || typeof url !== "string") return undefined
  return url
}

/**
 * A run whose process is only spawned once `prelude` settles, so preparation
 * that has to finish *before* DSH loads the profile still looks like a run to
 * the lifecycle — one that can be stopped, and whose failures are reported
 * through the same startup path.
 *
 * `exited` is deliberately left unsettled when no child was ever spawned. It
 * exists to report a process that died; a launch that never happened is already
 * being reported through `ready`, and answering here as well would race a second
 * failure into the lifecycle.
 */
export function deferDshRun(prelude: Promise<unknown>, launch: () => DshRun): DshRun {
  let stopped = false
  let started: DshRun | undefined
  const child = prelude.then(() => (stopped ? undefined : (started = launch())))
  const pending = new Promise<never>(() => {})
  return {
    ready: child.then((run) => run?.ready ?? pending),
    exited: child.then((run) => run?.exited ?? pending, () => pending),
    stop: async () => {
      stopped = true
      await child.catch(() => undefined)
      await started?.stop()
    },
  }
}

export function launchDshSidecar(options: LaunchDshSidecarOptions): DshRun {
  const child = options.spawn(
    options.executable,
    [
      "--expose-internals",
      "--import",
      options.sidecarPreload,
      options.dshBin,
      "web",
      "--patch",
      options.productPatch,
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  )

  let exitedAlready = false
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      exitedAlready = true
      resolve(code)
    })
  })

  let settled = false
  let stopping: Promise<void> | undefined
  let rejectReady!: (error: Error) => void
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  const waitForExit = () => {
    if (exitedAlready) return Promise.resolve(true)
    return new Promise<boolean>((resolveWait) => {
      const waitTimeout = setTimeout(() => resolveWait(false), stopTimeoutMs)
      void exited.then(() => {
        clearTimeout(waitTimeout)
        resolveWait(true)
      })
    })
  }

  const cleanupReadiness = () => {
    child.off("message", onMessage)
    child.off("exit", onEarlyExit)
  }

  const stopProcess = () => {
    stopping ??= (async () => {
      if (!settled) {
        settled = true
        cleanupReadiness()
        rejectReady(new Error("DSH stopped before readiness"))
      }
      if (exitedAlready || child.pid === undefined) return
      try {
        child.send("SIGTERM")
      } catch {
        child.kill()
      }
      if (await waitForExit()) return
      if (!exitedAlready) child.kill("SIGKILL")
      await waitForExit()
    })()
    return stopping
  }

  const fail = async (error: Error, terminate: boolean) => {
    if (settled) return
    settled = true
    cleanupReadiness()
    rejectReady(error)
    if (terminate && child.pid !== undefined) await stopProcess()
  }

  const onEarlyExit = (code: number | null) => {
    void fail(new Error(`DSH exited before readiness ${describeExit(code)}`), false)
  }

  // Spawn failure — an unexecutable helper, a bad path, a process table that
  // is full — arrives here rather than as a throw from spawn(), and it is the
  // one failure where no child exists: readiness will never time out, and the
  // exit event will never come, so this is the only signal there is. It stays
  // attached past readiness because kill and send report their failures the
  // same way, and dropping the listener would put the crash back.
  const onSpawnError = (error: Error) => {
    options.onError?.(error)
    void fail(new Error(`DSH failed to start: ${error.message}`, { cause: error }), true)
  }

  let resolveReady!: (url: string) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  const onMessage = (message: unknown) => {
    const url = readyUrlOf(message)
    if (url === undefined) return
    settled = true
    cleanupReadiness()
    resolveReady(url)
  }

  child.on("message", onMessage)
  // Both streams are forwarded whole and unbuffered. They are log now and
  // nothing else — no line here is parsed, and holding one back until its
  // newline would only hide the last thing a wedged or dying runtime said,
  // which is what the startup-failure dialog is built from.
  child.stdout?.on("data", (data: Buffer | string) => options.onStdout?.(data.toString()))
  child.stderr?.on("data", (data: Buffer | string) => options.onStderr?.(data.toString()))
  child.once("exit", onEarlyExit)
  child.on("error", onSpawnError)

  // There is deliberately no readiness deadline. The sidecar says nothing at
  // all until it is ready, so elapsed silence cannot tell a wedged runtime from
  // a slow one — a first launch behind an antivirus scan of the freshly
  // unpacked runtime looks exactly like a hang. A deadline here only ever
  // killed starts that were about to succeed (#1614). The failures that are
  // real announce themselves above: the process exits, or the spawn errors.
  return { ready, exited, stop: stopProcess }
}
