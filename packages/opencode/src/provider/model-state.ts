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

  /**
   * Pure: compute the next model.json contents, promoting `model` to the front of
   * `recent` (deduped, capped) while preserving every other field (favorite,
   * variant, …) so a write here never clobbers what the rest of opencode owns.
   */
  export function applyRecent(current: unknown, model: ModelRef, max: number = MAX_RECENT): Record<string, unknown> {
    const base = isRecord(current) ? current : {}
    const previous = Array.isArray(base.recent) ? base.recent : []
    const deduped = previous.filter(
      (entry) => !(isRecord(entry) && entry.providerID === model.providerID && entry.modelID === model.modelID),
    )
    const recent = [{ providerID: model.providerID, modelID: model.modelID }, ...deduped].slice(0, max)
    return { ...base, recent }
  }

  function isEnoent(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT"
  }

  /**
   * Best-effort persist of the user's picked model. Locked read-modify-write so a
   * concurrent CLI/desktop writer can neither corrupt the file (writeJson is not
   * atomic) nor drop sibling fields. A failure here must never break the caller.
   *
   * Only a missing file (ENOENT) starts from empty state. A parse error,
   * permission error, or transient read failure means the file may still hold
   * sibling state (favorite, variant, …); writing a fresh `{recent}` over it
   * would clobber that, so such a read failure skips this write instead.
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
        await Filesystem.writeJson(file, applyRecent(current, model))
      })
    } catch {
      // recording recent is best-effort — it must not surface to the caller
    }
  }
}
