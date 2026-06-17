import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { safeStorageCredentialStore, type CredentialStoreEnv } from "./remote-credentials"

// A deterministic fake env: a real tmp file for IO, identity "encryption" (utf8
// bytes <-> string) so the base64 envelope round-trips exactly like safeStorage
// would. No electron module mock — this test does not depend on which test file
// mocked "electron" first.
function fakeEnv(): CredentialStoreEnv {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-creds-"))
  return {
    credentialsFile: () => path.join(dir, "credentials.json"),
    stateFile: () => path.join(dir, "state.json"),
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(plain, "utf8"),
    decryptString: (cipher) => cipher.toString("utf8"),
  }
}

test("credential store round-trips userName through save/load", () => {
  const store = safeStorageCredentialStore(fakeEnv())

  store.save({ token: "123:ABC", allowFrom: "42", userName: "yuhan" })
  expect(store.load()).toEqual({ token: "123:ABC", allowFrom: "42", userName: "yuhan" })

  // A credential saved without a name still loads (userName simply absent).
  store.save({ token: "123:ABC", allowFrom: "42" })
  expect(store.load()).toEqual({ token: "123:ABC", allowFrom: "42", userName: undefined })
})

test("isAvailable reflects the env; save refuses when encryption is unavailable", () => {
  const base = fakeEnv()
  expect(safeStorageCredentialStore(base).isAvailable()).toBe(true)

  const store = safeStorageCredentialStore({ ...base, isEncryptionAvailable: () => false })
  expect(store.isAvailable()).toBe(false)
  expect(() => store.save({ token: "123:ABC", allowFrom: "42" })).toThrow(/secure storage is unavailable/)
})

test("save re-enforces 0o600 even when the file already exists with loose perms", () => {
  if (process.platform === "win32") return // POSIX mode bits only
  const env = fakeEnv()
  const file = env.credentialsFile()
  // An older build or a copied file could have left the token world-readable.
  writeFileSync(file, "stale", { mode: 0o644 })
  chmodSync(file, 0o644) // defeat umask so the precondition is genuinely loose
  safeStorageCredentialStore(env).save({ token: "123:ABC", allowFrom: "42" })
  expect(statSync(file).mode & 0o777).toBe(0o600)
})
