import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
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
