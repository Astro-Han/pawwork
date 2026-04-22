import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

type Roots = {
  data: string
  cache: string
  config: string
  state: string
}

function rootsFor(dir: string): Roots {
  return {
    data: path.join(dir, "share"),
    cache: path.join(dir, "cache"),
    config: path.join(dir, "config"),
    state: path.join(dir, "state"),
  }
}

function readGlobalPath(roots: Roots, namespace?: string) {
  const script = `
    process.env.XDG_DATA_HOME = ${JSON.stringify(roots.data)}
    process.env.XDG_CACHE_HOME = ${JSON.stringify(roots.cache)}
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(roots.config)}
    process.env.XDG_STATE_HOME = ${JSON.stringify(roots.state)}
    if (${JSON.stringify(namespace)} !== undefined) {
      process.env.PAWWORK_RUNTIME_NAMESPACE = ${JSON.stringify(namespace)}
    } else {
      delete process.env.PAWWORK_RUNTIME_NAMESPACE
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

function expectCoreRoots(paths: Record<string, string>, roots: Roots, namespace: string) {
  expect(paths.data).toBe(path.join(roots.data, namespace))
  expect(paths.cache).toBe(path.join(roots.cache, namespace))
  expect(paths.config).toBe(path.join(roots.config, namespace))
  expect(paths.state).toBe(path.join(roots.state, namespace))
}

describe("Global runtime namespace", () => {
  test("defaults to OpenCode namespace outside PawWork desktop", async () => {
    await using tmp = await tmpdir()
    const roots = rootsFor(tmp.path)
    const paths = readGlobalPath(roots)

    expectCoreRoots(paths, roots, "opencode")
  })

  test("uses PawWork namespace when enabled", async () => {
    await using tmp = await tmpdir()
    const roots = rootsFor(tmp.path)
    const paths = readGlobalPath(roots, "pawwork")

    expectCoreRoots(paths, roots, "pawwork")
    expect(paths.bin).toBe(path.join(roots.cache, "pawwork", "bin"))
    expect(paths.log).toBe(path.join(roots.data, "pawwork", "log"))
  })
})
