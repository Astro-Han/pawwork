type DshReadableStream = {
  on(event: "data", listener: (data: Buffer | string) => void): unknown
  off(event: "data", listener: (data: Buffer | string) => void): unknown
}

export interface DshChildProcess {
  readonly stdout: DshReadableStream | null
  readonly stderr: DshReadableStream | null
  readonly pid?: number
  kill(signal?: NodeJS.Signals | number): boolean
  on(event: "exit", listener: (code: number) => void): this
  once(event: "exit", listener: (code: number) => void): this
  off(event: "exit", listener: (code: number) => void): this
}

type SpawnDshProcess = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] },
) => DshChildProcess

type LaunchDshSidecarOptions = {
  executable: string
  dshBin: string
  zenIdentityPreload: string
  productHome: string
  productPatch: string
  toolsDir: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  stopTimeoutMs?: number
  spawn: SpawnDshProcess
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}

export type DshSidecar = {
  url: string
  exited: Promise<number>
  stop(): Promise<void>
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

export function launchDshSidecar(options: LaunchDshSidecarOptions): Promise<DshSidecar> {
  const child = options.spawn(
    options.executable,
    [
      "--expose-internals",
      "--import",
      options.zenIdentityPreload,
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let exitedAlready = false
  const exited = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      exitedAlready = true
      resolve(code)
    })
  })

  return new Promise<DshSidecar>((resolve, reject) => {
    let stdoutBuffer = ""
    let settled = false
    let stopping: Promise<void> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
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
        if (exitedAlready) return
        child.kill()
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
      if (terminate && child.pid !== undefined) await stopProcess()
      reject(error)
    }

    const onEarlyExit = (code: number) => {
      void fail(new Error(`DSH exited before readiness (code ${code})`), false)
    }

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
        resolve({
          url: match[1],
          exited,
          stop() {
            return stopProcess()
          },
        })
        return
      }
    }

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", (data: Buffer | string) => options.onStderr?.(data.toString()))
    child.once("exit", onEarlyExit)

    timeout = setTimeout(() => {
      void fail(new Error(`DSH did not announce readiness within ${options.timeoutMs}ms`), true)
    }, options.timeoutMs)
  })
}
import { delimiter } from "node:path"
