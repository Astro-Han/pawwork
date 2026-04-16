import fs from "node:fs/promises"
import path from "node:path"

const lockDir = path.resolve(import.meta.dir, "../../../../.tmp/embedded-server-artifact-lock")
const lockParent = path.dirname(lockDir)

export async function withEmbeddedServerArtifactLock<T>(run: () => Promise<T>) {
  const deadline = Date.now() + 120_000
  await fs.mkdir(lockParent, { recursive: true })

  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false })
      break
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for embedded server artifact lock at ${lockDir}`)
      }
      await Bun.sleep(100)
    }
  }

  try {
    return await run()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true })
  }
}
