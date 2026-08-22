import { delimiter } from "node:path"

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
  productHome: string
  productPatch: string
  toolsDir: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
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

const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+)(?: \(|$)/
const DEFAULT_STOP_TIMEOUT_MS = 5_000

export function withBundledToolsPath(env: NodeJS.ProcessEnv, toolsDir: string, separator = delimiter) {
  const result = { ...env }
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === "path")
  const pathKey = pathKeys[0] ?? "PATH"
  const current = result[pathKey]
  for (const duplicate of pathKeys.slice(1)) delete result[duplicate]
  result[pathKey] = current ? `${toolsDir}${separator}${current}` : toolsDir
  return result
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
      env: {
        ...withBundledToolsPath(options.env, options.toolsDir),
        DSH_HOME: options.productHome,
        ELECTRON_RUN_AS_NODE: "1",
      },
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
  let timeout: ReturnType<typeof setTimeout> | undefined
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
    if (timeout !== undefined) clearTimeout(timeout)
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
    const chunk = data.toString()
    options.onStdout?.(chunk)
    stdoutBuffer += chunk

    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      const match = READY_LINE.exec(line)
      if (!match) continue
      settled = true
      cleanupReadiness()
      resolveReady(match[1])
      return
    }
  }

  child.stdout?.on("data", onStdout)
  child.stderr?.on("data", (data: Buffer | string) => options.onStderr?.(data.toString()))
  child.once("exit", onEarlyExit)
  child.on("error", onSpawnError)

  timeout = setTimeout(() => {
    void fail(new Error(`DSH did not announce readiness within ${options.timeoutMs}ms`), true)
  }, options.timeoutMs)

  return { ready, exited, stop: stopProcess }
}
