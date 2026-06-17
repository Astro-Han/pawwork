import { rename, rm } from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"
import { isRecord } from "../util/record"

/**
 * Writes the user's picked model to the `recent` list in `state/model.json`, the
 * source `Provider.defaultModel()` reads when a prompt carries no explicit model.
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
   * Best-effort, locked read-modify-write. Only a missing file (ENOENT) starts
   * from empty; any other read failure skips the write so sibling state (favorite,
   * variant, …) is never clobbered. The temp-file + rename keeps the unlocked
   * `defaultModel()` reader from ever seeing a half-written file, and failures
   * never reach the caller.
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
