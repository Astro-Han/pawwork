import { expect, test } from "bun:test"
import { attemptDisconnect } from "./remote-disconnect"

test("a successful disconnect reports ok", async () => {
  const result = await attemptDisconnect(() => Promise.resolve())
  expect(result).toEqual({ ok: true })
})

test("a failed disconnect reports the error and never signals success", async () => {
  // The dialog branches on `ok`: a false result means it must NOT close, leaving
  // the credential's fate unambiguous to the user.
  const result = await attemptDisconnect(() => Promise.reject(new Error("keyring locked")))
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toBe("keyring locked")
})

test("a non-Error rejection is stringified", async () => {
  const result = await attemptDisconnect(() => Promise.reject("boom"))
  expect(result).toEqual({ ok: false, error: "boom" })
})
