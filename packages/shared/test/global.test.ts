import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "path"

function readSharedGlobalPath(namespace?: string) {
  const root = path.join(os.tmpdir(), "pawwork-shared-runtime-test")
  const data = path.join(root, "share")
  const cache = path.join(root, "cache")
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  const script = `
    process.env.XDG_DATA_HOME = ${JSON.stringify(data)}
    process.env.XDG_CACHE_HOME = ${JSON.stringify(cache)}
    process.env.XDG_CONFIG_HOME = ${JSON.stringify(config)}
    process.env.XDG_STATE_HOME = ${JSON.stringify(state)}
    if (${JSON.stringify(namespace)} !== undefined) {
      process.env.PAWWORK_RUNTIME_NAMESPACE = ${JSON.stringify(namespace)}
    } else {
      delete process.env.PAWWORK_RUNTIME_NAMESPACE
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
  return {
    paths: JSON.parse(result.stdout.toString()) as Record<string, string>,
    root: { data, cache, config, state },
  }
}

describe("shared Global runtime namespace", () => {
  test("defaults to OpenCode namespace outside PawWork desktop", () => {
    const { paths, root } = readSharedGlobalPath()
    expect(paths.data).toBe(path.join(root.data, "opencode"))
  })

  test("uses PawWork namespace when enabled", () => {
    const { paths, root } = readSharedGlobalPath("pawwork")

    expect(paths.data).toBe(path.join(root.data, "pawwork"))
    expect(paths.cache).toBe(path.join(root.cache, "pawwork"))
    expect(paths.config).toBe(path.join(root.config, "pawwork"))
    expect(paths.state).toBe(path.join(root.state, "pawwork"))
  })

  test("accepts PawWork variant namespaces", () => {
    const { paths, root } = readSharedGlobalPath("pawwork-dev")

    expect(paths.data).toBe(path.join(root.data, "pawwork"))
  })
})
