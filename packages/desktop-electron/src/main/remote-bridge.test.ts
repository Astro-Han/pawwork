import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { PlatformStatus } from "@opencode-ai/remote-bridge/gateway"
import {
  type CredentialStore,
  type PlatformPairer,
  type RemoteAccount,
  RemoteBridgeRuntime,
  type RemoteBridgeDeps,
  type RemotePairingEvent,
  type RemotePlatform,
} from "./remote-bridge"

function memoryStore(initial: RemoteAccount[] = [], available = true): CredentialStore & { value: RemoteAccount[] } {
  return {
    value: initial,
    isAvailable() {
      return available
    },
    load() {
      return this.value
    },
    save(accounts) {
      this.value = accounts
    },
    clear() {
      this.value = []
    },
  }
}

function sampleAccount(platform: RemotePlatform): RemoteAccount {
  switch (platform) {
    case "telegram":
      return { platform, token: "123:abc", allowFrom: "42", userName: "yu" }
    case "wechat":
      return { platform, botToken: "wx-tok", baseURL: "https://ilinkai.weixin.qq.com", allowFrom: "u@im.wechat", userName: "wx" }
  }
}

/** A fake pairer: emits one bind hint, then captures a fixed account. Overridable
 * so a test can script a slow / cancellable / failing flow. */
function fakePairer(platform: RemotePlatform, over: Partial<PlatformPairer> = {}): PlatformPairer {
  return {
    platform,
    async pair(_start, emit) {
      emit({ phase: "awaitingBind", platform, hint: "message" })
      return sampleAccount(platform)
    },
    makePlatform: () => ({ name: platform, start: async () => {}, reply: async () => {}, send: async () => {}, stop: async () => {} }),
    audience: () => ({ allow_from: "42" }),
    identity: () => ({ id: "42", name: `${platform} target` }),
    ...over,
  }
}

/** A bridge App whose run() emits "serving" for every configured platform (so the
 * runtime reaches "connected") and then stays pending until aborted. */
function servingApp(names: string[]) {
  return {
    run(signal?: AbortSignal, _onReady?: () => void, onStatus?: (status: PlatformStatus) => void) {
      for (const name of names) onStatus?.({ name, phase: "serving" })
      return hangUntilAbort(signal)
    },
  }
}

function hangUntilAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    signal?.addEventListener("abort", () => resolve(), { once: true })
  })
}

function deps(over: Partial<RemoteBridgeDeps> = {}): RemoteBridgeDeps {
  return {
    credentials: memoryStore(),
    statePath: "/tmp/state.json",
    serverInfo: async () => ({ url: "http://localhost:1", username: "u", password: "p" }),
    locale: () => "en",
    buildApp: async (config) => servingApp(config.platforms.map((platform) => platform.name)),
    pairers: [fakePairer("telegram")],
    ...over,
  }
}

function recordPairing(runtime: RemoteBridgeRuntime): RemotePairingEvent[] {
  const events: RemotePairingEvent[] = []
  runtime.onPairing((event) => events.push(event))
  return events
}

test("pairing emits the bind hint then captured, and confirm connects the channel", async () => {
  const store = memoryStore()
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store }))
  const events = recordPairing(runtime)
  await runtime.startPairing("telegram", { token: "123:abc" })
  expect(events.map((event) => event.phase)).toEqual(["awaitingBind", "captured"])

  await runtime.confirmPairing("telegram")
  expect(store.value).toEqual([{ platform: "telegram", token: "123:abc", allowFrom: "42", userName: "yu" }])
  const channel = runtime.getStatus().channels.find((c) => c.platform === "telegram")
  expect(channel?.state).toBe("connected")
  expect(channel?.identity).toEqual({ id: "42", name: "telegram target" })
  await runtime.stop()
})

test("startPairing fails fast on unavailable secure storage, without running the pairer", async () => {
  let paired = false
  const runtime = new RemoteBridgeRuntime(
    deps({
      credentials: memoryStore([], false),
      pairers: [fakePairer("telegram", { pair: async () => { paired = true; return sampleAccount("telegram") } })],
    }),
  )
  const events = recordPairing(runtime)
  await runtime.startPairing("telegram", { token: "x" })
  expect(events).toHaveLength(1)
  expect(events[0].phase).toBe("error")
  expect(events[0]).toMatchObject({ platform: "telegram" })
  expect(paired).toBe(false)
})

test("startPairing with no registered pairer emits an error", async () => {
  const runtime = new RemoteBridgeRuntime(deps({ pairers: [] }))
  const events = recordPairing(runtime)
  await runtime.startPairing("telegram")
  expect(events).toEqual([{ phase: "error", platform: "telegram", message: "unsupported platform telegram" }])
})

test("a pairer that throws surfaces an error event, not a rejection", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({ pairers: [fakePairer("telegram", { pair: async () => { throw new Error("could not reach Telegram") } })] }),
  )
  const events = recordPairing(runtime)
  await runtime.startPairing("telegram", { token: "bad" }) // resolves, never throws
  expect(events.at(-1)).toMatchObject({ phase: "error", platform: "telegram" })
  await expect(runtime.confirmPairing("telegram")).rejects.toThrow(/no pairing/)
})

test("cancelPairing aborts an in-flight flow and emits cancelled", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({
      pairers: [
        fakePairer("telegram", {
          pair: (_s, _e, signal) =>
            new Promise<RemoteAccount | null>((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
        }),
      ],
    }),
  )
  const events = recordPairing(runtime)
  const pairing = runtime.startPairing("telegram", { token: "x" })
  await Promise.resolve()
  runtime.cancelPairing()
  await pairing
  expect(events.at(-1)?.phase).toBe("cancelled")
  await expect(runtime.confirmPairing("telegram")).rejects.toThrow(/no pairing/)
})

test("a superseded pairing attempt stays silent instead of emitting cancelled", async () => {
  let calls = 0
  const runtime = new RemoteBridgeRuntime(
    deps({
      pairers: [
        fakePairer("telegram", {
          pair: (_start, emit, signal) => {
            calls++
            if (calls === 1) {
              // The first attempt parks until a newer startPairing aborts (supersedes) it.
              return new Promise<RemoteAccount | null>((resolve) =>
                signal.addEventListener("abort", () => resolve(null), { once: true }),
              )
            }
            emit({ phase: "awaitingBind", platform: "telegram", hint: "message" })
            return Promise.resolve(sampleAccount("telegram"))
          },
        }),
      ],
    }),
  )
  const events = recordPairing(runtime)
  const first = runtime.startPairing("telegram", { token: "a" })
  await Promise.resolve() // let the first attempt enter pair() and park on its signal
  const second = runtime.startPairing("telegram", { token: "b" }) // supersedes the first
  await Promise.all([first, second])

  // Only the second attempt's events reach the stream; the superseded first emits
  // nothing — no stray `cancelled` injected into the new attempt's dialog.
  expect(events.map((event) => event.phase)).toEqual(["awaitingBind", "captured"])
  await runtime.stop()
})

test("a pair() that resolves after cancel does not resurrect a pending pairing", async () => {
  let resolvePair: (account: RemoteAccount | null) => void = () => {}
  let entered = () => {}
  const enteredPromise = new Promise<void>((resolve) => (entered = resolve))
  const runtime = new RemoteBridgeRuntime(
    deps({
      pairers: [
        fakePairer("telegram", {
          pair: () => {
            entered()
            return new Promise<RemoteAccount | null>((resolve) => (resolvePair = resolve))
          },
        }),
      ],
    }),
  )
  const pairing = runtime.startPairing("telegram", { token: "x" })
  await enteredPromise
  runtime.cancelPairing()
  resolvePair(sampleAccount("telegram")) // a real sender arrives AFTER cancel — must be dropped
  await pairing
  await expect(runtime.confirmPairing("telegram")).rejects.toThrow(/no pairing/)
})

test("confirmPairing without a pending pairing is rejected (renderer cannot inject a secret)", async () => {
  const runtime = new RemoteBridgeRuntime(deps())
  await expect(runtime.confirmPairing("telegram")).rejects.toThrow(/no pairing/)
})

test("a double confirm builds only one bridge (the second finds no pending)", async () => {
  let built = 0
  let running = 0
  let maxRunning = 0
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({
        run(signal?: AbortSignal) {
          running++
          maxRunning = Math.max(maxRunning, running)
          built++
          return new Promise<void>((resolve) => {
            const done = () => {
              running--
              resolve()
            }
            if (signal?.aborted) return done()
            signal?.addEventListener("abort", done, { once: true })
          })
        },
      }),
    }),
  )
  await runtime.startPairing("telegram", { token: "x" })
  const results = await Promise.allSettled([runtime.confirmPairing("telegram"), runtime.confirmPairing("telegram")])
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"])
  expect(built).toBe(1)
  expect(maxRunning).toBe(1)
  await runtime.stop()
  expect(running).toBe(0)
})

test("a fatal run() failure degrades every channel, not an unhandled rejection", async () => {
  const runtime = new RemoteBridgeRuntime(
    deps({ buildApp: async () => ({ run: async () => { throw new Error("revoked token") } }) }),
  )
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")
  await new Promise((resolve) => setTimeout(resolve, 5)) // let the run rejection settle
  const channel = runtime.getStatus().channels.find((c) => c.platform === "telegram")
  expect(channel?.state).toBe("degraded")
  expect(channel?.error).toMatch(/revoked token/)
})

test("a confirmPairing whose bridge fails to build lands on degraded, not stuck connecting", async () => {
  const runtime = new RemoteBridgeRuntime(deps({ buildApp: async () => { throw new Error("server unreachable") } }))
  await runtime.startPairing("telegram", { token: "x" })
  await expect(runtime.confirmPairing("telegram")).rejects.toThrow(/server unreachable/)
  const channel = runtime.getStatus().channels.find((c) => c.platform === "telegram")
  expect(channel?.state).toBe("degraded")
  expect(channel?.error).toMatch(/server unreachable/)
})

test("status flips connecting → connected → degraded from the per-platform supervisor", async () => {
  let emit: ((status: PlatformStatus) => void) | undefined
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({
        run(signal?: AbortSignal, _onReady?: () => void, onStatus?: (status: PlatformStatus) => void) {
          emit = onStatus
          return hangUntilAbort(signal)
        },
      }),
    }),
  )
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")
  expect(runtime.getStatus().channels[0].state).toBe("connecting") // run started, not serving yet
  emit?.({ name: "telegram", phase: "serving" })
  expect(runtime.getStatus().channels[0].state).toBe("connected")
  emit?.({ name: "telegram", phase: "degraded", error: "ws closed" })
  expect(runtime.getStatus().channels[0]).toMatchObject({ state: "degraded", error: "ws closed" })
  await runtime.stop()
})

test("disconnecting the one channel clears it and empties the store", async () => {
  const store = memoryStore()
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store }))
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")
  expect(runtime.getStatus().channels.map((c) => c.platform)).toEqual(["telegram"])

  await runtime.disconnect("telegram")
  expect(runtime.getStatus().channels).toEqual([])
  expect(store.value).toEqual([])
  await runtime.stop()
})

test("disconnecting the last channel deletes the saved secret and the bridge state file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-state-"))
  const statePath = path.join(dir, "remote-bridge-state.json")
  // The gateway persists session pointers + the event cursor here while connected.
  writeFileSync(statePath, JSON.stringify({ pointers: { "telegram:1:2": "sess_old" } }))
  const store = memoryStore()
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store, statePath }))
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")

  await runtime.disconnect("telegram")
  expect(store.value).toEqual([])
  // No stale pointers / cursor survive to be inherited on the next connect.
  expect(existsSync(statePath)).toBe(false)
  await runtime.stop()
})

test("disconnect revokes access even when secure storage is unavailable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-state-"))
  const statePath = path.join(dir, "remote-bridge-state.json")
  writeFileSync(statePath, "{}")
  // Paired earlier, then the keyring went unavailable: revoke must still succeed,
  // not reject on a save([]) that requires encryption.
  const store = memoryStore([sampleAccount("telegram")], false)
  const runtime = new RemoteBridgeRuntime(deps({ credentials: store, statePath }))
  await runtime.startIfConfigured()

  await runtime.disconnect("telegram")
  expect(store.value).toEqual([])
  expect(existsSync(statePath)).toBe(false)
  await runtime.stop()
})

test("disconnecting the last channel stops the bridge before deleting state, so a late write can't resurrect it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-state-"))
  const statePath = path.join(dir, "remote-bridge-state.json")
  const runtime = new RemoteBridgeRuntime(
    deps({
      statePath,
      buildApp: async () => ({
        run(signal?: AbortSignal, _onReady?: () => void, onStatus?: (status: PlatformStatus) => void) {
          onStatus?.({ name: "telegram", phase: "serving" })
          return new Promise<void>((resolve) => {
            const finish = () => {
              // An in-flight handler persists pointers as the bridge tears down.
              writeFileSync(statePath, JSON.stringify({ pointers: { "telegram:1:2": "sess" } }))
              resolve()
            }
            if (signal?.aborted) return finish()
            signal?.addEventListener("abort", finish, { once: true })
          })
        },
      }),
    }),
  )
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")

  await runtime.disconnect("telegram")
  // stopBridge awaited the teardown (which wrote the file) before the delete ran.
  expect(existsSync(statePath)).toBe(false)
  await runtime.stop()
})

test("two channels run independently: one degrading or disconnecting leaves the other", async () => {
  // Telegram + WeChat are both real platforms now, so the multi-channel paths
  // (independent per-channel status, disconnect isolation) run against the actual
  // RemotePlatform union — no cast-past-union stand-in needed.
  let emitStatus: ((status: PlatformStatus) => void) | undefined
  const runtime = new RemoteBridgeRuntime(
    deps({
      pairers: [fakePairer("telegram"), fakePairer("wechat")],
      buildApp: async (config) => ({
        run(signal?: AbortSignal, _onReady?: () => void, onStatus?: (status: PlatformStatus) => void) {
          emitStatus = onStatus
          for (const platform of config.platforms) onStatus?.({ name: platform.name, phase: "serving" })
          return hangUntilAbort(signal)
        },
      }),
    }),
  )
  const stateOf = (platform: RemotePlatform) => runtime.getStatus().channels.find((c) => c.platform === platform)?.state

  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")
  await runtime.startPairing("wechat")
  await runtime.confirmPairing("wechat")
  expect(stateOf("telegram")).toBe("connected")
  expect(stateOf("wechat")).toBe("connected")

  // One channel degrades — the other is untouched.
  emitStatus?.({ name: "wechat", phase: "degraded", error: "connection lost" })
  expect(stateOf("wechat")).toBe("degraded")
  expect(stateOf("telegram")).toBe("connected")

  // Disconnecting one channel removes only it; the other survives as its own channel.
  await runtime.disconnect("telegram")
  expect(stateOf("telegram")).toBeUndefined()
  expect(runtime.getStatus().channels.map((c) => c.platform)).toEqual(["wechat"])
  await runtime.stop()
})

test("startIfConfigured connects saved accounts; with none it stays empty", async () => {
  const runtime = new RemoteBridgeRuntime(deps({ credentials: memoryStore([sampleAccount("telegram")]) }))
  await runtime.startIfConfigured()
  const channels = runtime.getStatus().channels
  expect(channels.map((c) => c.platform)).toEqual(["telegram"])
  expect(channels[0].state).toBe("connected")
  await runtime.stop()

  const empty = new RemoteBridgeRuntime(deps({ credentials: memoryStore([]) }))
  await empty.startIfConfigured()
  expect(empty.getStatus().channels).toEqual([])
})

test("stop() aborts the live bridge synchronously, before its returned promise settles", async () => {
  let abortedSync = false
  const runtime = new RemoteBridgeRuntime(
    deps({
      buildApp: async () => ({
        run(signal?: AbortSignal, _onReady?: () => void, onStatus?: (status: PlatformStatus) => void) {
          onStatus?.({ name: "telegram", phase: "serving" })
          return new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve()
            signal?.addEventListener("abort", () => { abortedSync = true; resolve() }, { once: true })
          })
        },
      }),
    }),
  )
  await runtime.startPairing("telegram", { token: "x" })
  await runtime.confirmPairing("telegram")
  expect(runtime.getStatus().channels[0].state).toBe("connected")

  const stopping = runtime.stop() // do not await yet
  expect(abortedSync).toBe(true) // abort landed on the sync prefix, before any await
  await stopping
})
