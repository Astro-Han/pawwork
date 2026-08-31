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
  once(event: "exit", listener: (code: number | null) => void): this
  off(event: "exit", listener: (code: number | null) => void): this
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

// DSH 0.1.2-alpha.2 announces `http://127.0.0.1:<port>/?token=<launch token>`:
// the root query token is the sole authentication input, and loading it mints
// the session cookie every later request rides on. Capture the whole URL, query
// included — an origin-only match would load an unauthenticated root and answer
// 401. The optional trailing group is the `(LAN: …)` suffix DSH appends when the
// server also bound a routable address.
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/?(?:\?\S*)?)(?: \(|$)/
// What makes a line an announcement rather than agent output, held to the same
// start-of-line rule READY_LINE uses so nothing the model echoes can trip it.
const READY_LINE_PREFIX = /^dsh web: /
const DEFAULT_STOP_TIMEOUT_MS = 5_000

/**
 * Keep the launch token out of anything that outlives the process. Since DSH
 * started authenticating the root URL with a query token, its readiness line
 * carries the one credential the whole session rests on — and the stdout stream
 * this reads from is mirrored into the persistent application log. The token is
 * useless without loopback access to the sidecar's port, but a log file is read
 * by more things, and for longer, than a live socket.
 */
export function redactLaunchToken(text: string) {
  return text.replace(/([?&]token=)[^\s&]+/g, "$1<redacted>")
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

  let stdoutBuffer = ""
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
    // Every terminal path for readiness passes here — resolved, failed, or
    // stopped — and it is the last moment stdout is read at all. Whatever the
    // final chunk left after its last newline is reported now rather than being
    // held for a newline that will never arrive.
    if (stdoutBuffer.length > 0) {
      options.onStdout?.(redactLaunchToken(stdoutBuffer))
      stdoutBuffer = ""
    }
    child.stdout?.off("data", onStdout)
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

  const onStdout = (data: Buffer | string) => {
    stdoutBuffer += data.toString()

    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ""
    // Reported from the same split the readiness scan uses, because a pipe
    // breaks where it fills rather than where a line ends: `?token=abc` can
    // arrive as `?tok` + `en=abc`, and a pattern applied to either chunk alone
    // matches neither half. A token never spans a newline, so a whole line is
    // the smallest unit that can be redacted at all.
    if (lines.length > 0) options.onStdout?.(`${lines.map(redactLaunchToken).join("\n")}\n`)
    for (const line of lines) {
      const match = READY_LINE.exec(line)
      if (!match) {
        // There is no readiness deadline (#1614), because silence cannot tell a
        // wedged runtime from a slow one. An announcement this cannot parse is
        // not silence: DSH is up, it said so, and only the shape it said it in
        // is unfamiliar. Waiting on that forever leaves the app in `starting`
        // with a healthy sidecar behind it and nothing on screen to explain it,
        // so it is reported as what it is — the one readiness failure that has
        // evidence. 0.1.2-alpha.2 moved this line once already, by adding the
        // launch token to the URL.
        if (READY_LINE_PREFIX.test(line)) {
          void fail(new Error(`DSH announced readiness in an unrecognized form: ${redactLaunchToken(line)}`), true)
          return
        }
        continue
      }
      settled = true
      cleanupReadiness()
      resolveReady(match[1])
      return
    }
  }

  child.stdout?.on("data", onStdout)
  // stderr is forwarded whole and unbuffered: it is what the startup-failure
  // dialog is built from, and holding a line back until its newline would hide
  // the last thing a wedged or dying runtime said. DSH announces the token on
  // stdout, so nothing here needs redacting.
  child.stderr?.on("data", (data: Buffer | string) => options.onStderr?.(data.toString()))
  child.once("exit", onEarlyExit)
  child.on("error", onSpawnError)

  // There is deliberately no readiness deadline. DSH prints nothing at all
  // until its ready line, so elapsed silence cannot tell a wedged runtime from
  // a slow one — a first launch behind an antivirus scan of the freshly
  // unpacked runtime looks exactly like a hang. A deadline here only ever
  // killed starts that were about to succeed (#1614). The failures that are
  // real announce themselves above: the process exits, or the spawn errors.
  return { ready, exited, stop: stopProcess }
}
