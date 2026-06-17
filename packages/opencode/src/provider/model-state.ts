import { rename, rm } from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"
import { isRecord } from "../util/record"

/**
 * Persists the user's picked model into `state/model.json`'s `recent` list — the
 * source `Provider.defaultModel()` reads when a prompt carries no explicit model.
 * Upstream opencode wrote this list from the TUI; PawWork replaced the TUI with
 * the desktop UI and kept only the reader, so a fresh session with no model
 * (e.g. a Telegram `/new`) fell through to the first configured provider instead
 * of the user's actual choice.
 *
 * This restores the writer, driven by the one place that truly knows the user
 * chose a model: the desktop model picker, which calls the `/provider/recent`
 * endpoint on an explicit pick. Recording at that single event — rather than
 * inferring intent from the prompt path — keeps an agent's pinned model, a
 * slash command, automation, or a subagent from ever leaking into the default,
 * with no provenance guessing.
 */
export namespace ModelState {
  export interface ModelRef {
    providerID: string
    modelID: string
  }

  // Keep enough history that defaultModel() can fall through to an older choice
  // when the most-recent provider/model is no longer connected.
  export const MAX_RECENT = 50

  function isModelRef(x: unknown): x is ModelRef {
    return isRecord(x) && typeof x.providerID === "string" && typeof x.modelID === "string"
  }

  /**
   * Pure: compute the next model.json contents, promoting `model` to the front of
   * `recent` (deduped, capped) while preserving every other field (favorite,
   * variant, …) so a write here never clobbers what the rest of opencode owns.
   */
  export function applyRecent(current: unknown, model: ModelRef, max: number = MAX_RECENT): Record<string, unknown> {
    const base = isRecord(current) ? current : {}
    // Drop malformed old entries: defaultModel() skips them when reading, so
    // keeping them here would only waste a cap slot and push a still-valid older
    // model out of `recent`.
    const previous = (Array.isArray(base.recent) ? base.recent : []).filter(isModelRef)
    const deduped = previous.filter(
      (entry) => !(entry.providerID === model.providerID && entry.modelID === model.modelID),
    )
    const recent = [{ providerID: model.providerID, modelID: model.modelID }, ...deduped].slice(0, max)
    return { ...base, recent }
  }

  function isEnoent(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT"
  }

  /**
   * Best-effort persist of the user's picked model. Locked read-modify-write so a
   * concurrent CLI/desktop writer can neither corrupt the file nor drop sibling
   * fields. A failure here must never break the caller.
   *
   * Only a missing file (ENOENT) starts from empty state. A parse error,
   * permission error, or transient read failure means the file may still hold
   * sibling state (favorite, variant, …); writing a fresh `{recent}` over it
   * would clobber that, so such a read failure skips this write instead.
   *
   * The write itself is atomic (temp file + rename): `Provider.defaultModel()`
   * reads this file unlocked and treats a parse failure as empty recent, and
   * `writeFile` is not atomic — rename guarantees a concurrent reader sees the old
   * or the new complete file, never a half-written one.
   */
  export async function recordRecent(model: ModelRef): Promise<void> {
    const file = path.join(Global.Path.state, "model.json")
    try {
      await Flock.withLock(`model-state:${file}`, async () => {
        let current: unknown
        try {
          current = await Filesystem.readJson<unknown>(file)
        } catch (err) {
          if (!isEnoent(err)) return
          current = undefined
        }
        const tmp = `${file}.${process.pid}.tmp`
        try {
          await Filesystem.write(tmp, JSON.stringify(applyRecent(current, model), null, 2))
          await rename(tmp, file)
        } finally {
          await rm(tmp, { force: true }).catch(() => {})
        }
      })
    } catch {
      // recording recent is best-effort — it must not surface to the caller
    }
  }
}
