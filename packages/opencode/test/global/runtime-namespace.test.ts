import { describe, expect, test } from "bun:test"
import path from "path"

function readGlobalPath(namespace?: string) {
  const script = `
    process.env.XDG_DATA_HOME = "/tmp/pawwork-runtime-test/share"
    process.env.XDG_CACHE_HOME = "/tmp/pawwork-runtime-test/cache"
    process.env.XDG_CONFIG_HOME = "/tmp/pawwork-runtime-test/config"
    process.env.XDG_STATE_HOME = "/tmp/pawwork-runtime-test/state"
    if (${JSON.stringify(namespace)} !== undefined) {
      process.env.PAWWORK_RUNTIME_NAMESPACE = ${JSON.stringify(namespace)}
    }
    const { Global } = await import("./src/global/index.ts")
    console.log(JSON.stringify(Global.Path))
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: path.join(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })

  if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
  return JSON.parse(Buffer.from(result.stdout).toString()) as Record<string, string>
}

describe("Global runtime namespace", () => {
  test("defaults to OpenCode namespace outside PawWork desktop", () => {
    const paths = readGlobalPath()

    expect(paths.data).toBe("/tmp/pawwork-runtime-test/share/opencode")
    expect(paths.cache).toBe("/tmp/pawwork-runtime-test/cache/opencode")
    expect(paths.config).toBe("/tmp/pawwork-runtime-test/config/opencode")
    expect(paths.state).toBe("/tmp/pawwork-runtime-test/state/opencode")
  })

  test("uses PawWork namespace when enabled", () => {
    const paths = readGlobalPath("pawwork")

    expect(paths.data).toBe("/tmp/pawwork-runtime-test/share/pawwork")
    expect(paths.cache).toBe("/tmp/pawwork-runtime-test/cache/pawwork")
    expect(paths.config).toBe("/tmp/pawwork-runtime-test/config/pawwork")
    expect(paths.state).toBe("/tmp/pawwork-runtime-test/state/pawwork")
    expect(paths.bin).toBe("/tmp/pawwork-runtime-test/cache/pawwork/bin")
    expect(paths.log).toBe("/tmp/pawwork-runtime-test/share/pawwork/log")
  })
})
