import { afterEach, expect, test } from "vitest"
import { applyUserShellPath, type ExecFileStub } from "./user-shell-env"

function stubExecFile(stdout: string): { execFile: ExecFileStub; calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = []
  return {
    calls,
    execFile(file, args, _options, callback) {
      calls.push({ file, args })
      callback(null, stdout, "")
      return {}
    },
  }
}

function stubFailingExecFile(): ExecFileStub {
  return (_file, _args, _options, callback) => {
    callback(new Error("boom"), "", "")
    return {}
  }
}

const savedShell = process.env.SHELL
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

test("prepends the login-shell PATH to the current environment", async () => {
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }
  const applied = await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(applied).toBe(true)
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
})

test("keeps current PATH directories the login shell does not know", async () => {
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/opt/pawwork-extra" }
  await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin:/opt/pawwork-extra")
})

test("reads the PATH from the last output line when the shell rc prints noise", async () => {
  const stub = stubExecFile("loading plugins…\n__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  const env: NodeJS.ProcessEnv = { PATH: "/bin" }
  await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
})

test("leaves the environment unchanged when the probe fails", async () => {
  const stub = stubFailingExecFile()
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }
  const applied = await applyUserShellPath({ env, platform: "darwin", execFile: stub })
  expect(applied).toBe(false)
  expect(env.PATH).toBe("/usr/bin:/bin")
})

test("probes the user's login and interactive shell", async () => {
  process.env.SHELL = "/opt/homebrew/bin/fish"
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  await applyUserShellPath({ env: {}, platform: "darwin", execFile: stub.execFile })
  expect(stub.calls).toEqual([
    { file: "/opt/homebrew/bin/fish", args: ["-lic", "printf \"\\n__pawwork_shell_path__%s\\n\" \"$PATH\""] },
  ])
})

test("falls back to zsh when SHELL is unset", async () => {
  delete process.env.SHELL
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  await applyUserShellPath({ env: {}, platform: "darwin", execFile: stub.execFile })
  expect(stub.calls).toEqual([
    { file: "/bin/zsh", args: ["-lic", "printf \"\\n__pawwork_shell_path__%s\\n\" \"$PATH\""] },
  ])
})

test("does nothing off macOS", async () => {
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  const env: NodeJS.ProcessEnv = { PATH: "/bin" }
  const applied = await applyUserShellPath({ env, platform: "win32", execFile: stub.execFile })
  expect(applied).toBe(false)
  expect(stub.calls).toHaveLength(0)
  expect(env.PATH).toBe("/bin")
})

test("splits a space-separated PATH from shells like fish", async () => {
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin /usr/bin /bin")
  const env: NodeJS.ProcessEnv = { PATH: "/bin" }
  await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
})
test("reads the marked line when the shell prints after the probe", async () => {
  const stub = stubExecFile("__pawwork_shell_path__/opt/homebrew/bin:/usr/bin\nzshexit cleanup")
  const env: NodeJS.ProcessEnv = { PATH: "/bin" }
  await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
})

test("reads the marker when rc noise has no trailing newline", async () => {
  // The probe's printf emits a leading newline, so rc noise without a trailing
  // newline cannot glue itself onto the marker line.
  const stub = stubExecFile("noise without newline\n__pawwork_shell_path__/opt/homebrew/bin:/usr/bin")
  const env: NodeJS.ProcessEnv = { PATH: "/bin" }
  await applyUserShellPath({ env, platform: "darwin", execFile: stub.execFile })
  expect(stub.calls[0].args[1]).toContain("\\n__pawwork_shell_path__%s")
  expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
})
