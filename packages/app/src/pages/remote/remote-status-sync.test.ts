import { expect, test } from "bun:test"
import type { RemoteStatus } from "@/desktop-api-contract"
import { subscribeRemoteStatus } from "./remote-status-sync"

const connected: RemoteStatus = {
  channels: [{ platform: "telegram", state: "connected", identity: { id: "1", name: "yu" }, error: null }],
}
const empty: RemoteStatus = { channels: [] }

test("a slow initial snapshot does not overwrite a live status update", async () => {
  const applied: RemoteStatus[] = []
  let resolveSnapshot: (status: RemoteStatus) => void = () => {}
  const listeners = new Set<(status: RemoteStatus) => void>()
  const source = {
    getStatus: () => new Promise<RemoteStatus>((resolve) => (resolveSnapshot = resolve)),
    onStatus: (cb: (status: RemoteStatus) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  subscribeRemoteStatus(source, (status) => applied.push(status))
  // A live update lands before the snapshot resolves.
  listeners.forEach((cb) => cb(connected))
  // The stale snapshot resolves last — it must be ignored.
  resolveSnapshot(empty)
  await Promise.resolve()

  expect(applied.at(-1)).toEqual(connected)
})

test("the initial snapshot applies when no live update has landed", async () => {
  const applied: RemoteStatus[] = []
  const source = {
    getStatus: () => Promise.resolve(connected),
    onStatus: () => () => {},
  }

  subscribeRemoteStatus(source, (status) => applied.push(status))
  await Promise.resolve()

  expect(applied.at(-1)).toEqual(connected)
})

test("a rejected snapshot is swallowed and a later live update still applies", async () => {
  const applied: RemoteStatus[] = []
  const listeners = new Set<(status: RemoteStatus) => void>()
  const source = {
    getStatus: () => Promise.reject(new Error("ipc down")),
    onStatus: (cb: (status: RemoteStatus) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }

  // A failed getStatus() IPC must not surface as an unhandled rejection...
  subscribeRemoteStatus(source, (status) => applied.push(status))
  await Promise.resolve()
  // ...and the live stream still drives the page afterwards.
  listeners.forEach((cb) => cb(connected))

  expect(applied).toEqual([connected])
})

test("a snapshot resolving after unsubscribe does not apply", async () => {
  let resolveSnapshot: (status: RemoteStatus) => void = () => {}
  const source = {
    getStatus: () => new Promise<RemoteStatus>((resolve) => (resolveSnapshot = resolve)),
    onStatus: () => () => {},
  }
  const applied: RemoteStatus[] = []

  const off = subscribeRemoteStatus(source, (status) => applied.push(status))
  off() // unsubscribed before the snapshot resolves
  resolveSnapshot(connected)
  await Promise.resolve()

  expect(applied).toEqual([])
})
