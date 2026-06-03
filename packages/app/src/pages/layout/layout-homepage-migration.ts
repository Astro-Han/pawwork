import { createEffect } from "solid-js"
import type { Platform } from "@/context/platform"
import { Persist } from "@/utils/persist"
import {
  runHomepageMigration,
  HOMEPAGE_MIGRATION_SENTINEL_KEY,
  type LegacyHomepagePromptStore,
} from "@/components/prompt-input/homepage-migration"
import { usePortableDraft } from "@/components/prompt-input/portable-draft"
import { createMigrationStorageIO } from "@/components/prompt-input/homepage-migration-storage"

export function useHomepageMigration(input: { currentDir: () => string; platform: Platform }) {
  // Run the v7 homepage-draft migration as soon as a directory becomes
  // available (fire-and-forget). currentDir() can be empty during the initial
  // autoselect phase, so onMount alone would skip migration for that session.
  // The migration writes a sentinel internally and is idempotent, so subsequent
  // effect ticks are no-ops once it has run.
  let homepageMigrationStarted = false
  createEffect(() => {
    if (homepageMigrationStarted) return
    const directory = input.currentDir()
    if (!directory) return
    homepageMigrationStarted = true

    const portable = usePortableDraft()
    const sentinelTarget = Persist.global(HOMEPAGE_MIGRATION_SENTINEL_KEY)
    const { read: readRaw, write: writeRaw, remove: removeRaw } = createMigrationStorageIO(input.platform)

    void runHomepageMigration({
      portable,
      currentDirectory: directory,
      readSentinel: async () => {
        const raw = await readRaw(sentinelTarget)
        if (!raw) return null
        try {
          return JSON.parse(raw) as import("@/components/prompt-input/homepage-migration").MigrationSentinel
        } catch {
          return null
        }
      },
      writeSentinel: async (sentinel) => {
        await writeRaw(sentinelTarget, JSON.stringify(sentinel))
      },
      loadLegacyHomepage: async (dir) => {
        const target = Persist.workspace(dir, "prompt")
        const raw = await readRaw(target)
        if (!raw) return null
        try {
          return JSON.parse(raw) as LegacyHomepagePromptStore
        } catch {
          return null
        }
      },
      clearLegacyHomepage: async (dir) => {
        // Must await: desktop removeItem is async and a rejection here must
        // propagate up to homepage-migration's failed-sentinel path. Without
        // the await, the migration would write status: "complete" even if
        // the legacy store delete failed.
        await removeRaw(Persist.workspace(dir, "prompt"))
      },
    }).catch((err) => {
      // Log diagnostic; migration retries automatically on next boot.
      console.warn("[homepage-migration] unexpected failure", err)
    })
  })
}
