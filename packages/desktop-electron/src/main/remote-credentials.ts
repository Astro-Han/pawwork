import { app, safeStorage } from "electron"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CredentialStore, RemoteCredentials } from "./remote-bridge"

// Chat credentials (bot token + paired user id) are secrets: they live only in
// the main process, encrypted at rest with Electron safeStorage, and never
// cross the renderer IPC boundary. The renderer only ever sees masked status.
// Stored separately from electron-store (which the renderer can read) for that
// reason.

const FILE_VERSION = 1

interface Envelope {
  version: number
  cipher: string // base64 of safeStorage.encryptString(JSON)
}

export function credentialsPath(): string {
  return path.join(app.getPath("userData"), "remote-bridge-credentials.json")
}

/**
 * The on-disk state file for the bridge's session pointers / event cursor.
 * Non-secret, but kept beside the credentials under userData so a disconnect
 * can wipe both. Returned as a path because `createApp` opens it itself.
 */
export function bridgeStatePath(): string {
  return path.join(app.getPath("userData"), "remote-bridge-state.json")
}

/**
 * safeStorage-backed credential store. Encryption is required: if the OS keyring
 * is unavailable (e.g. a headless Linux box with no secret service) we refuse to
 * persist rather than silently write a plaintext token. macOS and Windows always
 * have it.
 */
export function safeStorageCredentialStore(): CredentialStore {
  return {
    load(): RemoteCredentials | null {
      const file = credentialsPath()
      if (!existsSync(file)) return null
      try {
        const envelope = JSON.parse(readFileSync(file, "utf8")) as Envelope
        if (!envelope?.cipher) return null
        const plain = safeStorage.decryptString(Buffer.from(envelope.cipher, "base64"))
        const parsed = JSON.parse(plain) as RemoteCredentials
        if (!parsed?.token || !parsed?.allowFrom) return null
        return { token: parsed.token, allowFrom: parsed.allowFrom }
      } catch {
        // A corrupt or undecryptable file (e.g. moved between machines) is
        // treated as "not connected" rather than crashing startup.
        return null
      }
    },

    save(creds: RemoteCredentials): void {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("secure storage is unavailable on this system, cannot save the bot token")
      }
      const file = credentialsPath()
      mkdirSync(path.dirname(file), { recursive: true })
      const cipher = safeStorage.encryptString(JSON.stringify(creds)).toString("base64")
      const envelope: Envelope = { version: FILE_VERSION, cipher }
      writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
    },

    clear(): void {
      rmSync(credentialsPath(), { force: true })
      rmSync(bridgeStatePath(), { force: true })
    },
  }
}
