import { describe, expect, test } from "vitest"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
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
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: { PATH: "/usr/bin" },
      spawn: () => child,
    })

    child.stdout.write("[assistant] dsh web: http://127.0.0.1:1\n")
    child.stdout.write("dsh web: http://127.0.0.1:43123 (press h for help)\n")

    expect(await launched.ready).toBe("http://127.0.0.1:43123")

    await launched.stop()
  })

  // There is no readiness deadline (#1614): silence cannot tell a wedged runtime
  // from a slow one. A line DSH announces readiness on and this cannot parse is
  // not silence, and waiting on it forever leaves a healthy sidecar behind a
  // window stuck in `starting` with nothing on screen to explain it. alpha.2
  // moved this line once already, by adding the launch token to the URL.
  test("fails fast on an announcement it cannot parse rather than waiting forever", async () => {
    const child = new FakeChildProcess()
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/bin.js",
      sidecarPreload: "file:///app/preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
    })

    child.stdout.write("dsh web: https://dsh.example/?token=s3cr3t\n")

    await expect(launched.ready).rejects.toThrow(
      "DSH announced readiness in an unrecognized form: dsh web: https://dsh.example/?token=<redacted>",
    )
    // The runtime is still alive behind the failure, and leaving it running
    // would outlive the app that owns it.
    expect(child.messages).toEqual(["SIGTERM"])
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

  // #1614: DSH is silent until its ready line, so a slow start looks exactly
  // like a wedged one. Nothing may terminate the child on elapsed time alone.
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

    child.stdout.write("dsh web: http://127.0.0.1:4321\n")
    await expect(launched.ready).resolves.toBe("http://127.0.0.1:4321")
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

  // The readiness line carries the launch token, and the stdout callback feeds
  // the persistent application log. The ready URL this resolves is the one the
  // window loads, so redaction has to stop at the log and not reach it.
  test("keeps the launch token out of the reported output but not out of the URL", async () => {
    const child = new FakeChildProcess()
    const stdout: string[] = []
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
      onStdout: (chunk) => stdout.push(chunk),
    })

    // A pipe splits where it fills, not where a line ends, so the token key can
    // arrive in two writes. Both halves have to be redacted as one line.
    child.stdout.write("dsh web: http://127.0.0.1:43123/?tok")
    child.stdout.write("en=s3cr3t-launch-token (LAN: …)\n")
    const url = await launched.ready
    await launched.stop()

    expect(url).toBe("http://127.0.0.1:43123/?token=s3cr3t-launch-token")
    expect(stdout.join("")).toContain("http://127.0.0.1:43123/?token=<redacted>")
    expect(stdout.join("")).not.toContain("s3cr3t-launch-token")
  })

  // The startup-failure dialog is built from stderr, so a line held back for a
  // newline that never comes is a line the user never sees. DSH announces the
  // token on stdout, so nothing on this stream needs holding back for it.
  test("forwards stderr whole and unbuffered", async () => {
    const child = new FakeChildProcess()
    const stderr: string[] = []
    const launched = launchDshSidecar({
      executable: "/app/PawWork",
      dshBin: "/app/dsh.js",
      sidecarPreload: "file:///app/dsh/sidecar-preload.mjs",
      productPatch: "/data/dsh/product.cordis.patch.yml",
      env: {},
      spawn: () => child,
      onStderr: (chunk) => stderr.push(chunk),
    })

    child.stderr.write("FATAL: profile bundle is unresolved")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(stderr.join("")).toBe("FATAL: profile bundle is unresolved")

    child.emit("exit", 1)
    await expect(launched.ready).rejects.toThrow("DSH exited before readiness with code 1")
  })

  // The parameter this redacts is DSH's, not PawWork's: `redactLaunchToken` and
  // both fixtures above spell `token` because dsh-client-connection does. An
  // upstream rename turns redaction into a no-op that every test above still
  // passes, so the coupling is asserted where it actually lives.
  test("still redacts the query parameter DSH actually mints", () => {
    const connection = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-client-connection")

    expect(readFileSync(connection, "utf8")).toContain('const TOKEN_QUERY = "token"')
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
    child.stdout.write("dsh web: http://127.0.0.1:43123\n")
    await launched.ready

    await launched.stop()

    expect(child.messages).toEqual(["SIGTERM"])
    expect(child.killSignals).toEqual(["SIGKILL"])
  })
})
