import { afterAll, expect, mock, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const dir = mkdtempSync(path.join(tmpdir(), "remote-creds-"))

// Fake safeStorage: encrypt = utf8 bytes, decrypt = bytes back to string, so the
// envelope round-trips through base64 exactly like the real one would.
mock.module("electron", () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}))

afterAll(() => mock.restore())

test("credential store round-trips userName through save/load", async () => {
  const { safeStorageCredentialStore } = await import("./remote-credentials")
  const store = safeStorageCredentialStore()

  store.save({ token: "123:ABC", allowFrom: "42", userName: "yuhan" })
  expect(store.load()).toEqual({ token: "123:ABC", allowFrom: "42", userName: "yuhan" })

  // A credential saved without a name still loads (userName simply absent).
  store.save({ token: "123:ABC", allowFrom: "42" })
  expect(store.load()).toEqual({ token: "123:ABC", allowFrom: "42", userName: undefined })
})
