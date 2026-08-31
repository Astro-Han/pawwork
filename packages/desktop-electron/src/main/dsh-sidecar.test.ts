import { describe, expect, test } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { launchDshSidecar, type DshChildProcess } from "./dsh-sidecar"

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

  // What the `pawwork-product` plugin sends over the IPC channel once the tree
  // has settled and the Web server can serve the authenticated root.
  announceReady(url: string) {
    this.emit("message", { type: "pawwork:web-ready", url })
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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: { PATH: "/app/tools:/usr/bin", DSH_HOME: "/data/dsh", ELECTRON_RUN_AS_NODE: "1" },
      spawn: (executable, args, options) => {
        invocation = { executable, args, options }
        return child
      },
    })

    child.stdout.write("booting\n")
    child.announceReady("http://127.0.0.1:43123/?token=s3cr3t")
    const url = await launched.ready

    expect(url).toBe("http://127.0.0.1:43123/?token=s3cr3t")
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
        env: { PATH: "/app/tools:/usr/bin", DSH_HOME: "/data/dsh", ELECTRON_RUN_AS_NODE: "1" },
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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
    })

    const stoppedBeforeReady = sidecar.ready.catch((error: unknown) => error)
    await sidecar.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    await expect(stoppedBeforeReady).resolves.toBeInstanceOf(Error)
  })

  // Readiness is a message, not a sentence, and the difference is the point:
  // the sidecar's stdout carries agent output, so anything the model echoes
  // used to be one parser slip away from pointing the window at another origin.
  // Printed text is now inert whatever it says, and the announcement is
  // addressed rather than overheard.
  test("takes readiness only from the channel, never from what the sidecar prints", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/bin.js",
      sidecarPreload: "file:///app/preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: { PATH: "/usr/bin" },
      spawn: () => child,
    })
    let settled = false
    void launched.ready.finally(() => {
      settled = true
    })

    child.stdout.write("[assistant] dsh web: http://127.0.0.1:1/?token=evil\n")
    child.emit("message", { type: "pawwork:web-ready" })
    child.emit("message", "SIGTERM")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(false)

    child.announceReady("http://127.0.0.1:43123/?token=s3cr3t")

    expect(await launched.ready).toBe("http://127.0.0.1:43123/?token=s3cr3t")

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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
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

  // #1614: the sidecar says nothing until it is ready, so a slow start looks
  // exactly like a wedged one. Nothing may terminate the child on elapsed time
  // alone.
  test("leaves a silent child running instead of giving up on it", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
    })
    let settled = false
    void launched.ready.finally(() => {
      settled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(settled).toBe(false)
    expect([child.messages, child.killSignals]).toEqual([[], []])

    child.announceReady("http://127.0.0.1:4321/?token=s3cr3t")
    await expect(launched.ready).resolves.toBe("http://127.0.0.1:4321/?token=s3cr3t")
  })

  test("stops the owned child process once across concurrent and repeated calls", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
    })
    child.announceReady("http://127.0.0.1:43123/?token=s3cr3t")
    await launched.ready

    const firstStop = launched.stop()
    const concurrentStop = launched.stop()
    expect(concurrentStop).toBe(firstStop)
    await Promise.all([firstStop, concurrentStop])
    await launched.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killCount).toBe(0)
  })

  // Both streams are log and nothing else, so both are forwarded exactly as
  // they arrive. The startup-failure dialog is built from stderr, and a partial
  // line held back for a newline that never comes is the last thing a wedged
  // runtime said, withheld from the one screen that would have shown it.
  test("forwards both streams whole and unbuffered", async () => {
    const child = new FakeChildProcess()
    const stdout: string[] = []
    const stderr: string[] = []
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    })

    child.stdout.write("loading plugins")
    child.stderr.write("FATAL: profile bundle is unresolved")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(stdout.join("")).toBe("loading plugins")
    expect(stderr.join("")).toBe("FATAL: profile bundle is unresolved")

    child.emit("exit", 1)
    await expect(launched.ready).rejects.toThrow("DSH exited before readiness with code 1")
  })

  test("escalates a non-exiting graceful stop to force termination within a bound", async () => {
    const child = new FakeChildProcess()
    child.gracefulExit = false
    child.forceExit = false
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      stopTimeoutMs: 1,
      spawn: () => child,
    })
    child.announceReady("http://127.0.0.1:43123/?token=s3cr3t")
    await launched.ready

    await launched.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killSignals).toEqual(["SIGKILL"])
  })
})
