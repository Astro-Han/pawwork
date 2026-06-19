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
