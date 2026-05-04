import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

async function waitForFile(file: string) {
  for (let i = 0; i < 50; i++) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${file}`)
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node("setInterval(() => {}, 1000)"), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("aborts child processes started by a spawned process", async () => {
    if (process.platform === "win32") return

    await using tmp = await tmpdir()
    const pidFile = path.join(tmp.path, "child.pid")
    const child = `trap '' HUP TERM; echo $$ > ${JSON.stringify(pidFile)}; while :; do sleep 1; done`
    const abort = new AbortController()
    const proc = Process.spawn(["/bin/sh", "-c", `/bin/sh -c ${JSON.stringify(child)} & wait`], {
      abort: abort.signal,
      timeout: 50,
    })

    const childPid = Number((await waitForFile(pidFile)).trim())
    abort.abort()
    expect(await proc.exited).not.toBe(0)
    expect(Process.exists(childPid)).toBe(false)
  }, 3000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
      abort: abort.signal,
      nothrow: true,
      timeout: 25,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("terminateTree uses the platform process-tree cleanup path on Windows", async () => {
    if (process.platform !== "win32") return

    const proc = Process.spawn(node("setInterval(() => {}, 1000)"))
    await Process.terminateTree({ pid: proc.pid! })
    const exit = await Promise.race([
      proc.exited,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout waiting for process exit")), 3000)),
    ])

    expect(exit).not.toBe(0)
  }, 5000)

  test("terminateTree honors grace period without waitForExit", async () => {
    if (process.platform === "win32") return

    const proc = Process.spawn(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'))
    const started = Date.now()
    await Process.terminateTree({ pid: proc.pid!, graceMs: 120 })
    const elapsed = Date.now() - started

    expect(elapsed).toBeGreaterThanOrEqual(100)
    expect(await proc.exited).not.toBe(0)
  }, 3000)

  test("terminateTree falls back to root process when descendant enumeration fails", async () => {
    if (process.platform === "win32") return

    const proc = Process.spawn(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'))
    await Process.terminateTree({
      pid: proc.pid!,
      graceMs: 25,
      waitForExit: proc.exited,
      findDescendants: async () => {
        throw new Error("pgrep unavailable")
      },
    })

    expect(await proc.exited).not.toBe(0)
  }, 3000)

  test("stop uses the shared process tree termination path", async () => {
    if (process.platform === "win32") return

    const proc = Process.spawn(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'))
    await Process.stop(proc)

    expect(await proc.exited).not.toBe(0)
  }, 3000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.OPENCODE_TEST ?? "")'), {
      env: {
        OPENCODE_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "OPENCODE_TEST_SHELL"], {
      shell: true,
      env: {
        OPENCODE_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("OPENCODE_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })
})
