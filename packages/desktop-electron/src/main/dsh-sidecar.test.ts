import { describe, expect, test } from "vitest"
import { EventEmitter } from "node:events"
import { delimiter } from "node:path"
import { PassThrough } from "node:stream"
import { launchDshSidecar, type DshChildProcess, withBundledToolsPath } from "./dsh-sidecar"

class FakeChildProcess extends EventEmitter implements DshChildProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  pid: number | undefined = 42
  killed = false
  killCount = 0
  killSignals: Array<NodeJS.Signals | number | undefined> = []
  messages: unknown[] = []
  gracefulExit = true
  forceExit = true

  send(message: unknown) {
    this.messages.push(message)
    if (this.gracefulExit) {
      this.pid = undefined
      queueMicrotask(() => this.emit("exit", 0))
    }
    return true
  }

  // A spawn that never happened: Node reports it as an "error" event on a child
  // that has no pid, no stdio activity, and no exit to come.
  emitSpawnError(message = "spawn /app/PawWork EACCES") {
    this.pid = undefined
    this.emit("error", new Error(message))
  }

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

  // Node's process.env is case-insensitive on Windows, but an env object built by
  // hand is not, and a child that inherits both Path and PATH resolves tools from
  // whichever the process block happens to list. Only one may survive: the first,
  // with the tools directory in front of it.
  test("collapses a duplicated Windows path variable to one entry", () => {
    expect(withBundledToolsPath(
      { Path: "C:\\Windows", PATH: "C:\\Other", SHELL: "cmd" },
      "C:\\PawWork\\tools",
      ";",
    )).toEqual({
      Path: "C:\\PawWork\\tools;C:\\Windows",
      SHELL: "cmd",
    })
  })

  test("adds the tools directory when the environment has no path at all", () => {
    expect(withBundledToolsPath({ SHELL: "zsh" }, "/app/tools", ":")).toEqual({
      PATH: "/app/tools",
      SHELL: "zsh",
    })
  })

  test("loads the URL announced by the owned child process", async () => {
    const child = new FakeChildProcess()
    let invocation:
      | {
          executable: string
          args: string[]
          options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe", "ipc"] }
        }
      | undefined
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/node_modules/@deepseek-ai/dsh/lib/bin.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
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
    const url = await launched.ready

    expect(url).toBe("http://127.0.0.1:43123")
    expect(invocation).toEqual({
      executable: "/app/PawWork",
      args: [
        "--expose-internals",
        "--import",
        "file:///app/dsh/sidecar-preload.mjs",
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
        env: { PATH: `/app/tools${delimiter}/usr/bin`, DSH_HOME: "/data/dsh", ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    })

    await launched.stop()
    expect(child.messages).toEqual(["SIGTERM"])
  })

  test("owns and can stop the child immediately after spawn", async () => {
    const child = new FakeChildProcess()
    const sidecar = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })

    const stoppedBeforeReady = sidecar.ready.catch((error: unknown) => error)
    await sidecar.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    await expect(stoppedBeforeReady).resolves.toBeInstanceOf(Error)
  })

  // The sidecar's stdout carries agent output too, so the readiness line is only
  // trusted at the start of a line and only in the exact shape DSH prints. Drop
  // either half of that rule and anything the model echoes can point the app at
  // another port.
  test("trusts a readiness announcement only as a whole line", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/bin.js",
      sidecarPreload: "file:///app/preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: { PATH: "/usr/bin" },
      timeoutMs: 500,
      spawn: () => child,
    })

    child.stdout.write("[assistant] dsh web: http://127.0.0.1:1\n")
    child.stdout.write("dsh web: http://127.0.0.1:2suffix\n")
    child.stdout.write("dsh web: http://127.0.0.1:43123 (press h for help)\n")

    expect(await launched.ready).toBe("http://127.0.0.1:43123")

    await launched.stop()
  })

  // A signal kill has no exit code at all, and "code null" is not a status the
  // failure page can put in front of anyone.
  test("names a signal kill as the absence of a status rather than a null one", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })

    child.emit("exit", null)

    await expect(launched.ready).rejects.toThrow("DSH exited before readiness without a status code")
  })

  test("fails when the owned child process exits before announcing readiness", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })

    child.emit("exit", 23)

    await expect(launched.ready).rejects.toThrow("DSH exited before readiness with code 23")
  })

  // Without an "error" listener the EventEmitter rethrows the event as an
  // uncaught exception in the main process: the app dies before this promise can
  // settle, so the caller's catch never runs and nothing is ever reported.
  test("fails the launch when the child process never spawns", async () => {
    const child = new FakeChildProcess()
    const errors: Error[] = []
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
      onError: (error) => errors.push(error),
    })

    child.emitSpawnError()

    await expect(launched.ready).rejects.toThrow("DSH failed to start: spawn /app/PawWork EACCES")
    await launched.stop()
    expect(errors.map((error) => error.message)).toEqual(["spawn /app/PawWork EACCES"])
    // There is no process behind a failed spawn, so nothing may be signalled at
    // one: the pid is what says whether a child exists.
    expect([child.messages, child.killSignals]).toEqual([[], []])
  })

  test("force-terminates the owned child process when readiness times out", async () => {
    const child = new FakeChildProcess()
    child.gracefulExit = false
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 1,
      stopTimeoutMs: 1,
      spawn: () => child,
    })

    await expect(launched.ready).rejects.toThrow("DSH did not announce readiness within 1ms")
    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killSignals).toEqual(["SIGKILL"])
  })

  test("stops the owned child process once across concurrent and repeated calls", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      spawn: () => child,
    })
    child.stdout.write("dsh web: http://127.0.0.1:43123\n")
    await launched.ready

    const firstStop = launched.stop()
    const concurrentStop = launched.stop()
    expect(concurrentStop).toBe(firstStop)
    await Promise.all([firstStop, concurrentStop])
    await launched.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killCount).toBe(0)
  })

  test("escalates a non-exiting graceful stop to force termination within a bound", async () => {
    const child = new FakeChildProcess()
    child.gracefulExit = false
    child.forceExit = false
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productHome: "/data/dsh",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      toolsDir: "/app/tools",
      env: {},
      timeoutMs: 100,
      stopTimeoutMs: 1,
      spawn: () => child,
    })
    child.stdout.write("dsh web: http://127.0.0.1:43123\n")
    await launched.ready

    await launched.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killSignals).toEqual(["SIGKILL"])
  })
})
