import os from "os"
import path from "path"
import { Flock } from "../../src/util/flock"

const LOCK_KEY = "test-config-deps"
const LOCK_DIR = path.join(os.tmpdir(), "opencode-test-locks")
const LOCK_TIMEOUT_MS = 10_000

export async function withConfigDepsLock<T>(fn: () => Promise<T>): Promise<T> {
  await using _ = await Flock.acquire(LOCK_KEY, {
    dir: LOCK_DIR,
    staleMs: 30_000,
    timeoutMs: LOCK_TIMEOUT_MS,
    baseDelayMs: 20,
    maxDelayMs: 200,
  })
  return await fn()
}
