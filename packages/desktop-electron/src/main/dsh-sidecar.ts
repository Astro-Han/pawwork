type DshReadableStream = {
  on(event: "data", listener: (data: Buffer | string) => void): unknown
  off(event: "data", listener: (data: Buffer | string) => void): unknown
}

export interface DshChildProcess {
  readonly stdout: DshReadableStream | null
  readonly stderr: DshReadableStream | null
  readonly pid?: number
  kill(): boolean
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
  env: NodeJS.ProcessEnv
  timeoutMs: number
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
    ],
    {
      env: { ...options.env, DSH_HOME: options.productHome, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  child.once("exit", resolveExit)

  return new Promise<DshSidecar>((resolve, reject) => {
    let stdoutBuffer = ""
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const cleanupReadiness = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      child.stdout?.off("data", onStdout)
      child.off("exit", onEarlyExit)
    }

    const fail = (error: Error, terminate: boolean) => {
      if (settled) return
      settled = true
      cleanupReadiness()
      if (terminate && child.pid !== undefined) child.kill()
      reject(error)
    }

    const onEarlyExit = (code: number) => {
      fail(new Error(`DSH exited before readiness (code ${code})`), false)
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
        let stopping: Promise<void> | undefined
        resolve({
          url: match[1],
          exited,
          stop() {
            stopping ??= (async () => {
              if (child.pid === undefined) return
              child.kill()
              await exited
            })()
            return stopping
          },
        })
        return
      }
    }

    child.stdout?.on("data", onStdout)
    child.stderr?.on("data", (data: Buffer | string) => options.onStderr?.(data.toString()))
    child.once("exit", onEarlyExit)

    timeout = setTimeout(() => {
      fail(new Error(`DSH did not announce readiness within ${options.timeoutMs}ms`), true)
    }, options.timeoutMs)
  })
}
