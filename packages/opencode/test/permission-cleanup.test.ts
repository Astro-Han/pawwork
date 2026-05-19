import { afterEach, describe, expect, test } from "bun:test"
import { Permission } from "../src/permission"
import { AppRuntime } from "../src/effect/app-runtime"
import { Instance } from "../src/project/instance"
import { SessionID } from "../src/session/schema"
import { tmpdir } from "./fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const askPermission = (sessionID: SessionID) =>
  AppRuntime.runPromise(
    Permission.Service.use((svc) =>
      svc.ask({
        sessionID,
        permission: "edit",
        patterns: ["/tmp/file.txt"],
        always: ["/tmp/file.txt"],
        metadata: {},
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
      }),
    ),
  )

const listPermissions = () => AppRuntime.runPromise(Permission.Service.use((svc) => svc.list()))

const clearPermissionsForSession = (sessionID: SessionID) =>
  AppRuntime.runPromise(Permission.Service.use((svc) => svc.clearSession(sessionID, "session_deleted")))

async function waitForPending(timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pending = await listPermissions()
    if (pending.length === 1) return pending[0]!
    await Bun.sleep(10)
  }
  expect(await listPermissions()).toHaveLength(1)
  throw new Error("unreachable: assertion above always throws on miss")
}

describe("Permission.clearSession", () => {
  test("rejects pending permissions for the session and removes them from the list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_permission_cleanup")
        const promise = askPermission(sessionID)

        await waitForPending()
        await clearPermissionsForSession(sessionID)

        await expect(promise).rejects.toThrow("The user rejected permission to use this specific tool call.")
        expect(await listPermissions()).toEqual([])
      },
    })
  })
})
