import { describe, expect, test } from "bun:test"

describe("desktop sidecar source guard", () => {
  test("publishes PawWork credentials and does not block on stale migration probes", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text()

    expect(source).toContain("username: PAWWORK_RUNTIME.serverUsername")
    expect(source).toContain("const needsMigration = false")
    expect(source).toContain('app.setPath("logs", join(app.getPath("userData"), "logs"))')
    expect(source).toContain('logger.log("server ready", { url: res.url })')
    expect(source).toContain('logger.log("init done")')
    expect(source).toContain('const gracefulSidecarShutdown = process.platform === "darwin"')
    expect(source).toContain("event.preventDefault()")
    expect(source).toContain('logger.error("graceful sidecar shutdown timed out, forcing quit")')
    expect(source).toMatch(/const gracefulQuitTimeout = setTimeout\([\s\S]*?finishGracefulQuit\(\)[\s\S]*?10_000\)/)
    expect(source).toMatch(/\.finally\(\(\) => \{\s*clearTimeout\(gracefulQuitTimeout\)\s*finishGracefulQuit\(\)/)
    expect(source).toContain('Instance.disposeAll({ mode: "force" })')
    expect(source).toContain("await active.stop(true)")
    expect(source).toMatch(
      /try\s*{\s*await Instance\.disposeAll\({ mode: "force" }\)\s*}\s*finally\s*{\s*await active\.stop\(true\)/,
    )
    expect(source).not.toContain("sqliteFileExists")
    expect(source).not.toContain('username: "opencode"')
  })
})
