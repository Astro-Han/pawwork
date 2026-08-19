import { describe, expect, test } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { launchDshSidecar, type DshChildProcess, withBundledToolsPath } from "./dsh-sidecar"

class FakeChildProcess extends EventEmitter implements DshChildProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 42
  killed = false
  killCount = 0
  killSignals: Array<NodeJS.Signals | number | undefined> = []
  gracefulExit = true
  forceExit = true

  kill(signal?: NodeJS.Signals | number) {
    this.killed = true
    this.killCount += 1
    this.killSignals.push(signal)
    if ((signal === "SIGKILL" && this.forceExit) || (signal !== "SIGKILL" && this.gracefulExit)) {
      this.pid = undefined
      queueMicrotask(() => this.emit("exit", 0))
    }
    return true
  }
}

describe("DSH sidecar lifecycle", () => {
  test("prepends bundled tools to the existing PATH spelling", () => {
    expect(withBundledToolsPath({ PATH: "/usr/bin" }, "/app/tools", ":")).toEqual({
      PATH: "/app/tools:/usr/bin",
    })
    expect(withBundledToolsPath({ Path: "C:\\Windows" }, "C:\\PawWork\\tools", ";")).toEqual({
      Path: "C:\\PawWork\\tools;C:\\Windows",
    })
  })

  test("loads the URL announced by the owned child process", async () => {
    const child = new FakeChildProcess()
    let invocation:
      | {
          executable: string
          args: string[]
          options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }
        }
      | undefined
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/node_modules/@deepseek-ai/dsh/lib/bin.js",
      zenIdentityPreload: "file:///app/dsh/zen-identity-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: { PATH: "/usr/bin" },
      timeoutMs: 100,
      spawn: (executable, args, options) => {
        invocation = { executable, args, options }
        return child
      },
    })

    child.stdout.write("booting\ndsh web: http://127.0.0.1:43123\n")
    const sidecar = await launched

    expect(sidecar.url).toBe("http://127.0.0.1:43123")
    expect(invocation).toEqual({
      executable: "/app/PawWork",
      args: [
        "--expose-internals",
        "--import",
        "file:///app/dsh/zen-identity-preload.mjs",
        "/app/node_modules/@deepseek-ai/dsh/lib/bin.js",
        "web",
        "--patch",
        "/data/dsh/product.cordis.patch.yml",
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--no-open",
      ],
      options: {
        env: { PATH: "/app/tools:/usr/bin", DSH_HOME: "/data/dsh", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    })

    await sidecar.stop()
    expect(child.killed).toBe(true)
  })

  test("fails when the owned child process exits before announcing readiness", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      zenIdentityPreload: "file:///app/dsh/zen-identity-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })

    child.emit("exit", 23)

    await expect(launched).rejects.toThrow("DSH exited before readiness (code 23)")
  })

  test("force-terminates the owned child process when readiness times out", async () => {
    const child = new FakeChildProcess()
    child.gracefulExit = false
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      zenIdentityPreload: "file:///app/dsh/zen-identity-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 1,
      stopTimeoutMs: 1,
      spawn: () => child,
    })

    await expect(launched).rejects.toThrow("DSH did not announce readiness within 1ms")
    expect(child.killSignals).toEqual([undefined, "SIGKILL"])
  })

  test("stops the owned child process once across concurrent and repeated calls", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      zenIdentityPreload: "file:///app/dsh/zen-identity-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })
    child.stdout.write("dsh web: http://127.0.0.1:43123\n")
    const sidecar = await launched

    const firstStop = sidecar.stop()
    const concurrentStop = sidecar.stop()
    expect(concurrentStop).toBe(firstStop)
    await Promise.all([firstStop, concurrentStop])
    await sidecar.stop()

    expect(child.killCount).toBe(1)
  })

  test("escalates a non-exiting graceful stop to force termination within a bound", async () => {
    const child = new FakeChildProcess()
    child.gracefulExit = false
    child.forceExit = false
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      zenIdentityPreload: "file:///app/dsh/zen-identity-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      stopTimeoutMs: 1,
      spawn: () => child,
    })
    child.stdout.write("dsh web: http://127.0.0.1:43123\n")
    const sidecar = await launched

    await sidecar.stop()

    expect(child.killSignals).toEqual([undefined, "SIGKILL"])
  })
})
