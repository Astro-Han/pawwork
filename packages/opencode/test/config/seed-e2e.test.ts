import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Process } from "../../src/util/process"
import { withConfigDepsLock } from "../shared/config-deps-lock"

const packageRoot = path.resolve(import.meta.dir, "../..")
const repoRoot = path.resolve(import.meta.dir, "../../../../")

async function mkdir(name: string) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`))
}

describe("seed e2e script", () => {
  test("exits cleanly after creating the seeded session", async () => {
    await withConfigDepsLock(async () => {
      const [home, data, cache, config, state] = await Promise.all([
        mkdir("opencode-seed-home"),
        mkdir("opencode-seed-data"),
        mkdir("opencode-seed-cache"),
        mkdir("opencode-seed-config"),
        mkdir("opencode-seed-state"),
      ])

      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 5_000)

      try {
        const out = await Process.run(["bun", "script/seed-e2e.ts"], {
          cwd: packageRoot,
          abort: abort.signal,
          timeout: 100,
          nothrow: true,
          env: {
            OPENCODE_CLIENT: "app",
            OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
            OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
            OPENCODE_DISABLE_SHARE: "true",
            OPENCODE_E2E_PROJECT_DIR: repoRoot,
            OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
            OPENCODE_STRICT_CONFIG_DEPS: "true",
            OPENCODE_TEST_HOME: home,
            XDG_CACHE_HOME: cache,
            XDG_CONFIG_HOME: config,
            XDG_DATA_HOME: data,
            XDG_STATE_HOME: state,
          },
        })

        expect(out.code).toBe(0)
      } finally {
        clearTimeout(timer)
        await Promise.allSettled(
          [home, data, cache, config, state].map((dir) => fs.rm(dir, { recursive: true, force: true })),
        )
      }
    })
  }, 15_000)
})
