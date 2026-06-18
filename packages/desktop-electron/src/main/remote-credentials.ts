import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CredentialStore, RemoteCredentials } from "./remote-bridge"

// Chat credentials (bot token + paired user id) are secrets. The token crosses
// IPC exactly once, inbound, when the user pastes it into the connect dialog;
// from there it lives only in the main process, encrypted at rest with Electron
// safeStorage. It is never sent back out: the renderer only ever reads masked
// status, confirmPairing carries no token, and the stored secret never returns
// over IPC. Stored separately from electron-store (which the renderer can read)
// for that reason.

const FILE_VERSION = 1

interface Envelope {
  version: number
  cipher: string // base64 of safeStorage.encryptString(JSON)
}

/**
 * The OS-backed bits the credential store depends on: where the files live and
 * the safeStorage crypto. Injected rather than imported so this module stays free
 * of Electron — the store is unit-tested with a fake env. (Importing "electron"
 * in a unit test is order-dependent — other test files mock it — and throws
 * outright without an installed binary.) The Electron-backed env is wired in
 * index.ts.
 */
export interface CredentialStoreEnv {
  credentialsFile(): string
  stateFile(): string
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(cipher: Buffer): string
}

/**
 * safeStorage-backed credential store. Encryption is required: if the OS keyring
 * is unavailable (e.g. a headless Linux box with no secret service) we refuse to
 * persist rather than silently write a plaintext token. macOS and Windows always
 * have it.
 */
export function safeStorageCredentialStore(env: CredentialStoreEnv): CredentialStore {
  return {
    isAvailable(): boolean {
      return env.isEncryptionAvailable()
    },

    load(): RemoteCredentials | null {
      const file = env.credentialsFile()
      if (!existsSync(file)) return null
      try {
        const envelope = JSON.parse(readFileSync(file, "utf8")) as Envelope
        if (!envelope?.cipher) return null
        const plain = env.decryptString(Buffer.from(envelope.cipher, "base64"))
        const parsed = JSON.parse(plain) as RemoteCredentials
        if (!parsed?.token || !parsed?.allowFrom) return null
        // userName is the non-secret display name approved at pairing; without it
        // the settings page falls back to the raw user id after a restart.
        return { token: parsed.token, allowFrom: parsed.allowFrom, userName: parsed.userName }
      } catch {
        // A corrupt or undecryptable file (e.g. moved between machines) is
        // treated as "not connected" rather than crashing startup.
        return null
      }
    },

    save(creds: RemoteCredentials): void {
      if (!env.isEncryptionAvailable()) {
        throw new Error("secure storage is unavailable on this system, cannot save the bot token")
      }
      const file = env.credentialsFile()
      mkdirSync(path.dirname(file), { recursive: true })
      const cipher = env.encryptString(JSON.stringify(creds)).toString("base64")
      const envelope: Envelope = { version: FILE_VERSION, cipher }
      writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
      // writeFileSync's mode only applies when the file is created; rewriting an
      // existing file keeps its old permissions. Re-assert 0o600 so a token file
      // ever left world-readable is tightened on the next save. No-op on Windows,
      // which has no POSIX mode bits.
      chmodSync(file, 0o600)
    },

    clear(): void {
      rmSync(env.credentialsFile(), { force: true })
      rmSync(env.stateFile(), { force: true })
    },
  }
}
