import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "path"

function readSharedGlobalPath(namespace?: string) {
  const script = `
    process.env.XDG_DATA_HOME = "/tmp/pawwork-shared-runtime-test/share"
    process.env.XDG_CACHE_HOME = "/tmp/pawwork-shared-runtime-test/cache"
    process.env.XDG_CONFIG_HOME = "/tmp/pawwork-shared-runtime-test/config"
    process.env.XDG_STATE_HOME = "/tmp/pawwork-shared-runtime-test/state"
    if (${JSON.stringify(namespace)} !== undefined) {
      process.env.PAWWORK_RUNTIME_NAMESPACE = ${JSON.stringify(namespace)}
    }
    const { Effect } = await import("effect")
    const { Global } = await import("./src/global.ts")
    const paths = await Effect.gen(function* () {
      return yield* Global.Service
    }).pipe(Effect.provide(Global.layer), Effect.runPromise)
    console.log(JSON.stringify(paths))
  `
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: path.join(import.meta.dir, ".."),
    env: { ...process.env },
  })

  if (result.status !== 0) throw new Error(result.stderr.toString())
  return JSON.parse(result.stdout.toString()) as Record<string, string>
}

describe("shared Global runtime namespace", () => {
  test("defaults to OpenCode namespace outside PawWork desktop", () => {
    expect(readSharedGlobalPath().data).toBe("/tmp/pawwork-shared-runtime-test/share/opencode")
  })

  test("uses PawWork namespace when enabled", () => {
    const paths = readSharedGlobalPath("pawwork")

    expect(paths.data).toBe("/tmp/pawwork-shared-runtime-test/share/pawwork")
    expect(paths.cache).toBe("/tmp/pawwork-shared-runtime-test/cache/pawwork")
    expect(paths.config).toBe("/tmp/pawwork-shared-runtime-test/config/pawwork")
    expect(paths.state).toBe("/tmp/pawwork-shared-runtime-test/state/pawwork")
  })
})
