/**
 * One-shot homepage draft migration.
 *
 * On the first boot after upgrading to the global homepage draft model, the
 * user's existing per-workspace homepage draft (stored under the route-scoped
 * workspace store) is copied into the in-memory migration owner. The homepage
 * editor then projects that snapshot into the global homepage prompt store.
 *
 * Scope (PR1): only the CURRENTLY OPENED directory is handled. Other
 * workspaces' old homepage drafts remain in their route-scoped stores, and the
 * current directory's legacy store is preserved too. Those old stores are inert
 * after the sentinel is complete, but keeping them avoids deleting drafts before
 * the global store has definitely persisted.
 */

import type { Prompt, ContextItem } from "@/context/prompt"
import { DEFAULT_PROMPT } from "@/context/prompt-equality"
import type { PortableDraftOwner } from "./portable-draft"

export const HOMEPAGE_MIGRATION_SENTINEL_KEY = "prompt-portable-migration"

export interface MigrationSentinel {
  status: "pending" | "complete" | "failed"
  attemptedAt: number
  /** Set when content was actually adopted; undefined when legacy store was empty. */
  adoptedDirectory?: string
  failedReason?: string
}

/** Shape of the legacy route-scoped homepage prompt store. */
export interface LegacyHomepagePromptStore {
  prompt: Prompt
  cursor?: number
  context: {
    items: (ContextItem & { key: string })[]
  }
}

/**
 * Dependency injection surface — passed in by callers so the migration
 * function itself has no reactive coupling and is fully unit-testable.
 */
export interface HomepageMigrationDeps {
  /** Load the legacy route-scoped homepage store for the given directory. Returns null when absent. */
  loadLegacyHomepage: (directory: string) => Promise<LegacyHomepagePromptStore | null>
  /** Read the global migration sentinel. Returns null when not yet written. */
  readSentinel: () => Promise<MigrationSentinel | null>
  /** Persist the migration sentinel globally. */
  writeSentinel: (sentinel: MigrationSentinel) => Promise<void>
  /** Portable draft owner that receives the adopted content. */
  portable: PortableDraftOwner
  /** True filesystem directory that is currently opened. */
  currentDirectory: string
  /** Injected for tests; defaults to Date.now. */
  now?: () => number
}

/**
 * Return true when the legacy store has content worth migrating:
 * - prompt text is non-empty/non-whitespace, OR
 * - context items are present.
 */
function hasLegacyContent(store: LegacyHomepagePromptStore): boolean {
  const { prompt, context } = store

  const promptHasText =
    prompt.length > 1 ||
    (prompt.length === 1 && prompt[0]?.type === "text" && !!prompt[0].content.trim())

  // Non-text parts (file, agent, image) in the prompt also count as content.
  const promptHasNonTextParts = prompt.some((part) => part.type !== "text")

  return promptHasText || promptHasNonTextParts || context.items.length > 0
}

/**
 * Run the one-shot homepage draft migration.
 *
 * Idempotent: returns immediately if the sentinel is already "complete".
 * On legacy-load failure, sets sentinel to "failed" where possible and returns,
 * allowing retry on the next boot. Final sentinel-write failures bubble to the
 * caller so layout can log them.
 */
export async function runHomepageMigration(deps: HomepageMigrationDeps): Promise<MigrationSentinel> {
  const { loadLegacyHomepage, readSentinel, writeSentinel, portable, currentDirectory } = deps
  const now = deps.now ?? (() => Date.now())

  // 1. Check sentinel — if already complete, no-op.
  const existing = await readSentinel()
  if (existing?.status === "complete") {
    return existing
  }

  const attemptedAt = now()

  // 2. Load legacy route-scoped homepage store for the current directory.
  let legacy: LegacyHomepagePromptStore | null
  try {
    legacy = await loadLegacyHomepage(currentDirectory)
  } catch (err) {
    const failedReason = err instanceof Error ? err.message : String(err)
    const sentinel: MigrationSentinel = { status: "failed", attemptedAt, failedReason }
    await writeSentinel(sentinel).catch(() => undefined)
    return sentinel
  }

  // 3. Determine if there is meaningful content to adopt.
  const hasContent = legacy !== null && hasLegacyContent(legacy)

  if (hasContent && legacy !== null) {
    // 4. Copy into the in-memory migration owner.
    portable.record({
      sourceFilesystemDirectory: currentDirectory,
      prompt: legacy.prompt,
      context: legacy.context.items,
      images: [],
      resolvedMentions: {},
    })
  }

  // 5. Write complete sentinel. Once complete, the route-scoped legacy store is ignored.
  const sentinel: MigrationSentinel = {
    status: "complete",
    attemptedAt,
    adoptedDirectory: hasContent ? currentDirectory : undefined,
  }
  await writeSentinel(sentinel)
  return sentinel
}
