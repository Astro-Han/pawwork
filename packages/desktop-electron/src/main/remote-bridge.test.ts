import { expect, test } from "bun:test"
import {
  PairingCancelledError,
  RemoteBridgeRuntime,
  type CapturedSender,
  type CredentialStore,
  type RemoteBridgeDeps,
  type RemoteCredentials,
} from "./remote-bridge"

function memoryStore(initial: RemoteCredentials | null = null): CredentialStore & { value: RemoteCredentials | null } {
  return {
    value: initial,
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

/** A fake bridge App whose run() stays pending until aborted, like the real one. */
function fakeApp() {
  let started = false
  return {
    started: () => started,
    app: {
      run(signal?: AbortSignal) {
        started = true
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
    buildApp: async () => fakeApp().app,
    makePoller: () => ({ getMe: async () => ({ id: "1", username: "bot" }) }) as any,
    capture: async () => ({ userId: "42", userName: "yu" }) as CapturedSender,
    makePlatform: () => ({ name: "telegram", start: async () => {}, reply: async () => {}, send: async () => {}, stop: async () => {} }),
    ...overrides,
  }
}

test("startPairing returns the captured sender plus bot identity", async () => {
  const runtime = new RemoteBridgeRuntime(deps())
  const result = await runtime.startPairing("123:abc")
  expect(result).toEqual({ userId: "42", userName: "yu", botUsername: "bot" })
})

test("startPairing surfaces an invalid token before asking the user to message", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({ makePoller: () => ({ getMe: async () => { throw new Error("401 Unauthorized") } }) as any }),
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

test("confirmPairing saves credentials and reports connected", async () => {
  const store = memoryStore()
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store }))
  await runtime.confirmPairing("123:abc", "42", "yu")
  expect(store.value).toEqual({ token: "123:abc", allowFrom: "42", userName: "yu" })
  const status = runtime.getStatus()
  expect(status.state).toBe("connected")
  expect(status.platform).toBe("telegram")
  expect(status.identity).toEqual({ userId: "42", userName: "yu" })
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

test("concurrent connect calls only ever build one live bridge", async () => {
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
  await Promise.all([
    runtime.confirmPairing("t", "1"),
    runtime.confirmPairing("t", "2"),
    runtime.confirmPairing("t", "3"),
  ])
  // Each confirm stops the previous bridge before starting its own, so the
  // serial queue never has two running at once.
  expect(maxRunning).toBe(1)
  expect(built).toBe(3)
  await runtime.stop()
  expect(running).toBe(0)
})

test("a fatal run() failure becomes degraded status, not an unhandled rejection", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({ run: async () => { throw new Error("revoked token") } }),
    }),
  )
  await runtime.confirmPairing("t", "42")
  // The run rejection is observed on a microtask; let it settle.
  await new Promise((r) => setTimeout(r, 5))
  const status = runtime.getStatus()
  expect(status.state).toBe("degraded")
  expect(status.error).toMatch(/revoked token/)
})
