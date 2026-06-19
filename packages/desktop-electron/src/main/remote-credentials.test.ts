import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { RemoteAccount } from "./remote-bridge"
import { safeStorageCredentialStore, type CredentialStoreEnv } from "./remote-credentials"

// A deterministic fake env: a real tmp file for IO, identity "encryption" (utf8
// bytes <-> string) so the base64 envelope round-trips exactly like safeStorage
// would. No electron module mock — this test does not depend on which test file
// mocked "electron" first.
function fakeEnv(): CredentialStoreEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-creds-"))
  return {
    credentialsFile: () => path.join(dir, "credentials.json"),
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, "utf8"),
    decryptString: (cipher) => cipher.toString("utf8"),
  }
}

test("round-trips a saved account list", () => {
  const store = safeStorageCredentialStore(fakeEnv())
  const accounts: RemoteAccount[] = [{ platform: "telegram", token: "123:ABC", allowFrom: "42", userName: "yuhan" }]
  store.save(accounts)
  expect(store.load()).toEqual(accounts)
})

test("an empty save clears the list", () => {
  const store = safeStorageCredentialStore(fakeEnv())
  store.save([{ platform: "telegram", token: "t", allowFrom: "42" }])
  store.save([])
  expect(store.load()).toEqual([])
})

test("the load filter drops unrecognizable entries", () => {
  const store = safeStorageCredentialStore(fakeEnv())
  store.save([{ platform: "telegram", token: "t", allowFrom: "42" }, { platform: "mystery" } as unknown as RemoteAccount])
  expect(store.load()).toEqual([{ platform: "telegram", token: "t", allowFrom: "42" }])
})

test("migrates a v1 single-credential file to a one-element telegram list", () => {
  const env = fakeEnv()
  // The pre-array format: a single Telegram credential object in the same envelope.
  const cipher = env.encryptString(JSON.stringify({ token: "123:ABC", allowFrom: "42", userName: "yuhan" })).toString("base64")
  writeFileSync(env.credentialsFile(), JSON.stringify({ version: 1, cipher }))
  expect(safeStorageCredentialStore(env).load()).toEqual([
    { platform: "telegram", token: "123:ABC", allowFrom: "42", userName: "yuhan" },
  ])
})

test("isAvailable reflects the env; save refuses when encryption is unavailable", () => {
  const base = fakeEnv()
  expect(safeStorageCredentialStore(base).isAvailable()).toBe(true)

  const store = safeStorageCredentialStore({ ...base, isEncryptionAvailable: () => false })
  expect(store.isAvailable()).toBe(false)
  expect(() => store.save([{ platform: "telegram", token: "t", allowFrom: "42" }])).toThrow(/secure storage is unavailable/)
})

test("save re-enforces 0o600 even when the file already exists with loose perms", () => {
  if (process.platform === "win32") return // POSIX mode bits only
  const env = fakeEnv()
  const file = env.credentialsFile()
  // An older build or a copied file could have left the token world-readable.
  writeFileSync(file, "stale", { mode: 0o644 })
  chmodSync(file, 0o644) // defeat umask so the precondition is genuinely loose
  safeStorageCredentialStore(env).save([{ platform: "telegram", token: "123:ABC", allowFrom: "42" }])
  expect(statSync(file).mode & 0o777).toBe(0o600)
})
