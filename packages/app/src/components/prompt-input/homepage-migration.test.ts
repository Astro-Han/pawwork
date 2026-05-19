import { describe, expect, test, beforeEach } from "bun:test"
import {
  runHomepageMigration,
  type HomepageMigrationDeps,
  type MigrationSentinel,
  type LegacyHomepagePromptStore,
} from "./homepage-migration"
import { createPortableDraftOwner } from "./portable-draft"
import { DEFAULT_PROMPT } from "@/context/prompt"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyLegacyStore(): LegacyHomepagePromptStore {
  return {
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: undefined,
    context: { items: [] },
  }
}

function legacyStoreWithText(text: string): LegacyHomepagePromptStore {
  return {
    prompt: [{ type: "text", content: text, start: 0, end: text.length }],
    cursor: undefined,
    context: { items: [] },
  }
}

function legacyStoreWithContext(): LegacyHomepagePromptStore {
  return {
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: undefined,
    context: {
      items: [
        {
          type: "file",
          path: "/some/file.ts",
          key: "file:/some/file.ts:undefined:undefined",
        },
      ],
    },
  }
}

/** Build a minimal HomepageMigrationDeps with injectable store and sentinel. */
function makeDeps(overrides: Partial<HomepageMigrationDeps> & { legacy?: LegacyHomepagePromptStore | null }): {
  deps: HomepageMigrationDeps
  sentinelStore: { value: MigrationSentinel | null }
  legacyStore: { value: LegacyHomepagePromptStore | null }
  cleared: string[]
  portable: ReturnType<typeof createPortableDraftOwner>
} {
  const sentinelStore: { value: MigrationSentinel | null } = { value: null }
  const legacyStore: { value: LegacyHomepagePromptStore | null } = { value: overrides.legacy ?? null }
  const cleared: string[] = []
  const portable = createPortableDraftOwner()

  const deps: HomepageMigrationDeps = {
    portable,
    currentDirectory: "/workspace/my-project",
    now: () => 1000,
    loadLegacyHomepage: async (_dir) => legacyStore.value,
    clearLegacyHomepage: async (dir) => {
      cleared.push(dir)
    },
    readSentinel: async () => sentinelStore.value,
    writeSentinel: async (s) => {
      sentinelStore.value = s
    },
    ...overrides,
  }

  return { deps, sentinelStore, legacyStore, cleared, portable }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runHomepageMigration", () => {
  test("no-op when sentinel is already complete", async () => {
    const existingSentinel: MigrationSentinel = {
      status: "complete",
      attemptedAt: 500,
      adoptedDirectory: "/workspace/my-project",
    }
    const { deps, sentinelStore, cleared, portable } = makeDeps({
      legacy: legacyStoreWithText("hello"),
    })
    sentinelStore.value = existingSentinel

    const result = await runHomepageMigration(deps)

    expect(result).toBe(existingSentinel)
    expect(portable.snapshot()).toBeNull()
    expect(cleared).toHaveLength(0)
  })

  test("subsequent calls with complete sentinel skip the work entirely", async () => {
    const { deps, sentinelStore, cleared, portable } = makeDeps({
      legacy: legacyStoreWithText("some draft"),
    })

    // First call — runs migration.
    const first = await runHomepageMigration(deps)
    expect(first.status).toBe("complete")
    const snapshotAfterFirst = portable.snapshot()
    expect(snapshotAfterFirst).not.toBeNull()
    expect(cleared).toHaveLength(1)

    // Reset cleared array but keep sentinel as complete.
    cleared.length = 0
    // Simulate portal state being reset (new boot simulation).
    const portable2 = createPortableDraftOwner()
    const deps2: HomepageMigrationDeps = {
      ...deps,
      portable: portable2,
    }

    const second = await runHomepageMigration(deps2)
    expect(second).toBe(sentinelStore.value!) // same sentinel object returned
    expect(portable2.snapshot()).toBeNull() // no adoption on second call
    expect(cleared).toHaveLength(0)
  })

  test("adopts legacy content into portable when non-empty", async () => {
    const { deps, portable } = makeDeps({ legacy: legacyStoreWithText("write a test") })

    await runHomepageMigration(deps)

    const snap = portable.snapshot()
    expect(snap).not.toBeNull()
    expect(snap?.sourceFilesystemDirectory).toBe("/workspace/my-project")
    expect(snap?.prompt).toEqual([{ type: "text", content: "write a test", start: 0, end: 12 }])
    expect(snap?.context).toEqual([])
    expect(snap?.images).toEqual([])
  })

  test("clears the legacy store after successful adoption", async () => {
    const { deps, cleared } = makeDeps({ legacy: legacyStoreWithText("draft content") })

    await runHomepageMigration(deps)

    expect(cleared).toEqual(["/workspace/my-project"])
  })

  test("writes sentinel as complete with adoptedDirectory set when content existed", async () => {
    const { deps, sentinelStore } = makeDeps({ legacy: legacyStoreWithText("plan the sprint") })

    await runHomepageMigration(deps)

    expect(sentinelStore.value?.status).toBe("complete")
    expect(sentinelStore.value?.adoptedDirectory).toBe("/workspace/my-project")
    expect(sentinelStore.value?.attemptedAt).toBe(1000)
  })

  test("writes sentinel as complete with adoptedDirectory undefined when no content", async () => {
    const { deps, sentinelStore, portable } = makeDeps({ legacy: null })

    await runHomepageMigration(deps)

    expect(sentinelStore.value?.status).toBe("complete")
    expect(sentinelStore.value?.adoptedDirectory).toBeUndefined()
    expect(portable.snapshot()).toBeNull()
  })

  test("writes sentinel as complete with adoptedDirectory undefined when store is empty", async () => {
    const { deps, sentinelStore, portable, cleared } = makeDeps({ legacy: emptyLegacyStore() })

    await runHomepageMigration(deps)

    expect(sentinelStore.value?.status).toBe("complete")
    expect(sentinelStore.value?.adoptedDirectory).toBeUndefined()
    expect(portable.snapshot()).toBeNull()
    // Nothing to clear when store was empty.
    expect(cleared).toHaveLength(0)
  })

  test("does not write sentinel as complete when clearLegacy throws (status: failed, failedReason set)", async () => {
    const { deps, sentinelStore, portable } = makeDeps({
      legacy: legacyStoreWithText("important draft"),
      clearLegacyHomepage: async () => {
        throw new Error("disk full")
      },
    })

    const result = await runHomepageMigration(deps)

    expect(result.status).toBe("failed")
    expect(result.failedReason).toBe("disk full")
    expect(sentinelStore.value?.status).toBe("failed")
    // Adoption was attempted before clear failed; portable may or may not have content —
    // the key invariant is the sentinel is NOT complete.
    expect(sentinelStore.value?.status).not.toBe("complete")
  })

  test("does not call portable.record when no legacy content exists", async () => {
    const { deps, portable } = makeDeps({ legacy: null })

    await runHomepageMigration(deps)

    expect(portable.snapshot()).toBeNull()
  })

  test("does not call portable.record when only whitespace text exists", async () => {
    const { deps, portable, cleared } = makeDeps({ legacy: legacyStoreWithText("   ") })

    await runHomepageMigration(deps)

    expect(portable.snapshot()).toBeNull()
    expect(cleared).toHaveLength(0)
  })

  test("adopts legacy content when context items are present even with empty prompt", async () => {
    const { deps, portable, cleared } = makeDeps({ legacy: legacyStoreWithContext() })

    await runHomepageMigration(deps)

    const snap = portable.snapshot()
    expect(snap).not.toBeNull()
    expect(snap?.context).toHaveLength(1)
    expect(cleared).toHaveLength(1)
  })

  test("sets failed status and failedReason when loadLegacyHomepage throws", async () => {
    const { deps, sentinelStore, portable } = makeDeps({
      loadLegacyHomepage: async () => {
        throw new Error("storage unavailable")
      },
    })

    const result = await runHomepageMigration(deps)

    expect(result.status).toBe("failed")
    expect(result.failedReason).toBe("storage unavailable")
    expect(sentinelStore.value?.status).toBe("failed")
    expect(portable.snapshot()).toBeNull()
  })
})
