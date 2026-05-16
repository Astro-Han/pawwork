import { fileURLToPath } from "node:url"

const appRoot = fileURLToPath(new URL("../..", import.meta.url))

export function runBrowserCheck(script: string) {
  const cmd = [process.execPath, "--conditions=browser", "--preload", "./happydom.ts", "-e", script]
  const result = Bun.spawnSync({
    cmd,
    cwd: appRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)

  if (stdout === "" && stderr === "" && result.exitCode === 0) return

  throw new Error(
    [
      "Browser subprocess check failed.",
      `cwd: ${appRoot}`,
      `command: ${cmd.map((part) => JSON.stringify(part)).join(" ")}`,
      `exitCode: ${result.exitCode}`,
      stdout === "" ? "stdout: <empty>" : `stdout:\n${stdout}`,
      stderr === "" ? "stderr: <empty>" : `stderr:\n${stderr}`,
    ].join("\n"),
  )
}
