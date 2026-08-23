import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"

type DshCommandResult = { stderr: string; stdout: string }
type ProcessResult = DshCommandResult & { exitCode: number }
type ExecuteProcess = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<ProcessResult>

type CreateDshCommandRuntimeOptions = {
  dshBin: string
  env: NodeJS.ProcessEnv
  executable: string
  home: string
  platform?: NodeJS.Platform
  pnpmBin: string
  execute?: ExecuteProcess
}

const OUTPUT_LIMIT = 64 * 1024

function appendOutput(current: string, chunk: Buffer | string) {
  return (current + chunk.toString()).slice(-OUTPUT_LIMIT)
}

const executeProcess: ExecuteProcess = (executable, args, options) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk) })
  child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk) })
  child.once("error", reject)
  child.once("close", (code) => resolve({ exitCode: code ?? 1, stderr, stdout }))
})

function preparePnpmShim(options: CreateDshCommandRuntimeOptions) {
  const tools = join(options.home, ".tools")
  mkdirSync(tools, { mode: 0o700, recursive: true })
  const windows = (options.platform ?? process.platform) === "win32"
  const path = join(tools, windows ? "pnpm.cmd" : "pnpm")
  const content = windows
    ? '@"%PAWWORK_NODE_EXECUTABLE%" "%PAWWORK_PNPM_CLI%" %*\r\n'
    : '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$PAWWORK_PNPM_CLI" "$@"\n'
  writeFileSync(path, content, windows ? undefined : { mode: 0o700 })
  return tools
}

export function createDshCommandRuntime(options: CreateDshCommandRuntimeOptions) {
  const tools = preparePnpmShim(options)
  const separator = (options.platform ?? process.platform) === "win32" ? ";" : ":"
  const environment = {
    ...options.env,
    DSH_HOME: options.home,
    ELECTRON_RUN_AS_NODE: "1",
    PATH: [tools, options.env.PATH].filter(Boolean).join(separator),
    PAWWORK_NODE_EXECUTABLE: options.executable,
    PAWWORK_PNPM_CLI: options.pnpmBin,
  }
  return {
    environment,
    async run(args: string[]): Promise<DshCommandResult> {
      const result = await (options.execute ?? executeProcess)(options.executable, [options.dshBin, ...args], {
        cwd: options.home,
        env: environment,
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `DSH exited with code ${result.exitCode}`)
      return { stderr: result.stderr, stdout: result.stdout }
    },
  }
}
