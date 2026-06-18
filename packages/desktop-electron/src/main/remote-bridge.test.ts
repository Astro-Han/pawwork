import { expect, test } from "bun:test"
import {
  PairingCancelledError,
  RemoteBridgeRuntime,
  type CapturedSender,
  type CredentialStore,
  type RemoteBridgeDeps,
  type RemoteCredentials,
} from "./remote-bridge"

function memoryStore(
  initial: RemoteCredentials | null = null,
  available = true,
): CredentialStore & { value: RemoteCredentials | null } {
  return {
    value: initial,
    isAvailable() {
      return available
    },
    load() {
      return this.value
    },
    save(creds) {
      this.value = creds
    },
    clear() {
      this.value = null
    },
  }
}

/** A fake bridge App whose run() stays pending until aborted, like the real one.
 * It signals readiness immediately, the way a platform that has finished its
 * backlog drain would, so the runtime reaches "connected". */
function fakeApp() {
  let started = false
  return {
    started: () => started,
    app: {
      run(signal?: AbortSignal, onReady?: () => void) {
        started = true
        onReady?.()
        return new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve()
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    },
  }
}

function deps(overrides: Partial<RemoteBridgeDeps> = {}): RemoteBridgeDeps {
  return {
    credentials: memoryStore(),
    statePath: "/tmp/state.json",
    serverInfo: async () => ({ url: "http://localhost:1", username: "u", password: "p" }),
    locale: () => "en",
    buildApp: async () => fakeApp().app,
    makePoller: () => ({ getMe: async () => ({ id: "1", username: "bot" }) }) as any,
    capture: async () => ({ userId: "42", userName: "yu", botUsername: "bot" }) as CapturedSender,
    makePlatform: () => ({ name: "telegram", start: async () => {}, reply: async () => {}, send: async () => {}, stop: async () => {} }),
    ...overrides,
  }
}

test("startPairing returns the captured sender plus bot identity", async () => {
  const runtime = new RemoteBridgeRuntime(deps())
  const result = await runtime.startPairing("123:abc")
  expect(result).toEqual({ userId: "42", userName: "yu", botUsername: "bot" })
})

test("startPairing fails fast when secure storage is unavailable, without contacting Telegram", async () => {
  let pollerMade = false
  let captureCalled = false
  const runtime = new RemoteBridgeRuntime(
    deps({
      credentials: memoryStore(null, false),
      makePoller: () => {
        pollerMade = true
        return { getMe: async () => ({ id: "1", username: "bot" }) } as any
      },
      capture: async () => {
        captureCalled = true
        return { userId: "42", userName: "yu" } as CapturedSender
      },
    }),
  )
  await expect(runtime.startPairing("123:abc")).rejects.toThrow(/secure storage is unavailable/)
  // The whole point of the preflight: no poller, no getMe/getUpdates, no capture.
  expect(pollerMade).toBe(false)
  expect(captureCalled).toBe(false)
})

test("startPairing surfaces an invalid token before asking the user to message", async () => {
  // The token is now proven inside capture (its drain hits a fatal 401 before any
  // sender is awaited); a thrown capture maps to the reach-Telegram error.
  const runtime = new RemoteBridgeRuntime(
    deps({
      capture: async () => {
        throw new Error("401 Unauthorized")
      },
    }),
  )
  await expect(runtime.startPairing("bad")).rejects.toThrow(/could not reach Telegram/)
})

test("cancelPairing aborts capture and surfaces a cancellation", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({
      capture: (_poller, signal) =>
        new Promise<CapturedSender | null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
    }),
  )
  const pending = runtime.startPairing("123:abc")
  await Promise.resolve()
  runtime.cancelPairing()
  await expect(pending).rejects.toBeInstanceOf(PairingCancelledError)
})

test("a capture that resolves after cancelPairing does not resurrect a pending pairing", async () => {
  let captureEntered = () => {}
  const entered = new Promise<void>((r) => (captureEntered = r))
  let resolveCapture: (s: CapturedSender | null) => void = () => {}
  const runtime = new RemoteBridgeRuntime(
    deps({
      capture: () => {
        captureEntered()
        return new Promise<CapturedSender | null>((resolve) => (resolveCapture = resolve))
      },
    }),
  )
  const pending = runtime.startPairing("123:abc")
  await entered
  runtime.cancelPairing()
  // The capture resolves with a real sender AFTER the user cancelled — it must be
  // dropped, not stored, or a later confirm would pair an abandoned identity.
  resolveCapture({ userId: "42", userName: "yu" })
  await expect(pending).rejects.toBeInstanceOf(PairingCancelledError)
  await expect(runtime.confirmPairing()).rejects.toThrow(/no pairing/)
})

test("confirmPairing persists the captured pairing and reports connected", async () => {
  const store = memoryStore()
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store }))
  await runtime.startPairing("123:abc") // fake capture returns user 42 / yu
  await runtime.confirmPairing() // no token passed — main-side pending is used
  expect(store.value).toEqual({ token: "123:abc", allowFrom: "42", userName: "yu" })
  const status = runtime.getStatus()
  expect(status.state).toBe("connected")
  expect(status.platform).toBe("telegram")
  expect(status.identity).toEqual({ userId: "42", userName: "yu" })
})

test("status stays 'connecting' until the bridge signals it is serving (onReady)", async () => {
  // The startup-race fix: app.run() merely returning a promise is not "connected".
  // The real run still has to ready the stream, hydrate, and drain the Telegram
  // backlog before its poll loop exists; a message sent in that window is dropped.
  // Hold onReady to observe that pre-serving window, then release it.
  let release: (() => void) | undefined
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({
        run: (signal?: AbortSignal, onReady?: () => void) => {
          release = onReady
          return new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      }),
    }),
  )
  await runtime.startPairing("t")
  await runtime.confirmPairing()
  // run() has started but the platform is not serving yet — must not be connected.
  expect(runtime.getStatus().state).toBe("connecting")
  release?.()
  expect(runtime.getStatus().state).toBe("connected")
  await runtime.stop()
})

test("confirmPairing without a pending pairing is rejected (renderer cannot inject a token)", async () => {
  const runtime = new RemoteBridgeRuntime(deps())
  await expect(runtime.confirmPairing()).rejects.toThrow(/no pairing/)
})

test("disconnect stops the bridge and wipes credentials", async () => {
  const store = memoryStore({ token: "t", allowFrom: "42" })
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store }))
  await runtime.startIfConfigured()
  expect(runtime.getStatus().state).toBe("connected")
  await runtime.disconnect()
  expect(store.value).toBeNull()
  expect(runtime.getStatus().state).toBe("disconnected")
})

test("startIfConfigured does nothing without saved credentials", async () => {
  const runtime = new RemoteBridgeRuntime(deps({ credentials: memoryStore(null) }))
  await runtime.startIfConfigured()
  expect(runtime.getStatus().state).toBe("disconnected")
})

test("a double confirm builds only one bridge (the second finds no pending)", async () => {
  let built = 0
  let running = 0
  let maxRunning = 0
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => {
        built++
        return {
          run(signal?: AbortSignal) {
            running++
            maxRunning = Math.max(maxRunning, running)
            return new Promise<void>((resolve) => {
              const done = () => {
                running--
                resolve()
              }
              if (signal?.aborted) return done()
              signal?.addEventListener("abort", done, { once: true })
            })
          },
        }
      },
    }),
  )
  await runtime.startPairing("t")
  // A double-clicked Allow: the first consumes the pending pairing and builds;
  // the second finds none, so only one live bridge is ever started.
  const results = await Promise.allSettled([runtime.confirmPairing(), runtime.confirmPairing()])
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"])
  expect(built).toBe(1)
  expect(maxRunning).toBe(1)
  await runtime.stop()
  expect(running).toBe(0)
})

test("a fatal run() failure becomes degraded status, not an unhandled rejection", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({ run: async () => { throw new Error("revoked token") } }),
    }),
  )
  await runtime.startPairing("t")
  await runtime.confirmPairing()
  // The run rejection is observed on a microtask; let it settle.
  await new Promise((r) => setTimeout(r, 5))
  const status = runtime.getStatus()
  expect(status.state).toBe("degraded")
  expect(status.error).toMatch(/revoked token/)
})

test("a confirmPairing whose bridge fails to build lands on degraded, not stuck connecting", async () => {
  // serverInfo/buildApp can throw before run() ever starts (e.g. the server is
  // unreachable). confirmPairing awaits startBridge directly — unlike
  // startIfConfigured — so without the degraded fallback the status would hang on
  // "connecting" forever.
  const runtime = new RemoteBridgeRuntime(
    deps({ buildApp: async () => { throw new Error("server unreachable") } }),
  )
  await runtime.startPairing("t")
  await expect(runtime.confirmPairing()).rejects.toThrow(/server unreachable/)
  const status = runtime.getStatus()
  expect(status.state).toBe("degraded")
  expect(status.error).toMatch(/server unreachable/)
})

test("stop() aborts the live bridge synchronously, before its returned promise settles", async () => {
  // before-quit runs `void stop(); killSidecar()` without awaiting. The abort must
  // fire on the synchronous prefix of stop(), so the poller is already tearing down
  // before the sidecar it talks to is killed.
  let abortedSync = false
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({
        run: (signal?: AbortSignal, onReady?: () => void) => {
          onReady?.()
          return new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener("abort", () => { abortedSync = true; resolve() }, { once: true })
          })
        },
      }),
    }),
  )
  await runtime.startPairing("t")
  await runtime.confirmPairing()
  expect(runtime.getStatus().state).toBe("connected")

  const stopping = runtime.stop() // do not await yet
  expect(abortedSync).toBe(true) // abort landed on the sync prefix, before any await
  await stopping
})
