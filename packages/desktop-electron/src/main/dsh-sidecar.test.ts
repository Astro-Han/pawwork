import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { launchDshSidecar, type DshChildProcess } from "./dsh-sidecar"

class FakeChildProcess extends EventEmitter implements DshChildProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 42
  killed = false

  kill() {
    this.killed = true
    this.pid = undefined
    queueMicrotask(() => this.emit("exit", 0))
    return true
  }
}

describe("DSH sidecar lifecycle", () => {
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
      ],
      options: {
        env: { PATH: "/usr/bin", DSH_HOME: "/data/dsh", ELECTRON_RUN_AS_NODE: "1" },
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
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })

    child.emit("exit", 23)

    await expect(launched).rejects.toThrow("DSH exited before readiness (code 23)")
  })
})
