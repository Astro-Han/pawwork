import { test, expect } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Auth } from "../../src/auth"

function runAuth<A, E>(fn: (auth: Auth.Interface) => import("effect").Effect.Effect<A, E, never>) {
  return AppRuntime.runPromise(Auth.Service.use(fn))
}

test("set normalizes trailing slashes in keys", async () => {
  await runAuth((auth) =>
    auth.set("https://example.com/", {
      type: "wellknown",
      key: "TOKEN",
      token: "abc",
    }),
  )
  const data = await runAuth((auth) => auth.all())
  expect(data["https://example.com"]).toBeDefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set cleans up pre-existing trailing-slash entry", async () => {
  // Simulate a pre-fix entry with trailing slash
  await runAuth((auth) =>
    auth.set("https://example.com/", {
      type: "wellknown",
      key: "TOKEN",
      token: "old",
    }),
  )
  // Re-login with normalized key (as the CLI does post-fix)
  await runAuth((auth) =>
    auth.set("https://example.com", {
      type: "wellknown",
      key: "TOKEN",
      token: "new",
    }),
  )
  const data = await runAuth((auth) => auth.all())
  const keys = Object.keys(data).filter((k) => k.includes("example.com"))
  expect(keys).toEqual(["https://example.com"])
  const entry = data["https://example.com"]!
  expect(entry.type).toBe("wellknown")
  if (entry.type === "wellknown") expect(entry.token).toBe("new")
})

test("remove deletes both trailing-slash and normalized keys", async () => {
  await runAuth((auth) =>
    auth.set("https://example.com", {
      type: "wellknown",
      key: "TOKEN",
      token: "abc",
    }),
  )
  await runAuth((auth) => auth.remove("https://example.com/"))
  const data = await runAuth((auth) => auth.all())
  expect(data["https://example.com"]).toBeUndefined()
  expect(data["https://example.com/"]).toBeUndefined()
})

test("set and remove are no-ops on keys without trailing slashes", async () => {
  await runAuth((auth) =>
    auth.set("anthropic", {
      type: "api",
      key: "sk-test",
    }),
  )
  const data = await runAuth((auth) => auth.all())
  expect(data["anthropic"]).toBeDefined()
  await runAuth((auth) => auth.remove("anthropic"))
  const after = await runAuth((auth) => auth.all())
  expect(after["anthropic"]).toBeUndefined()
})
