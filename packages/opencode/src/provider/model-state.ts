import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"

/**
 * Persists the user's last-used model into `state/model.json`'s `recent` list —
 * the source `Provider.defaultModel()` reads when a prompt carries no explicit
 * model. Upstream opencode wrote this list from the TUI; PawWork replaced the TUI
 * with the desktop UI and kept only the reader, so a fresh session with no model
 * (e.g. a Telegram `/new`) fell through to the first configured provider instead
 * of the user's actual choice. This restores the writer on the server side.
 */
export namespace ModelState {
  export interface ModelRef {
    providerID: string
    modelID: string
  }

  // Keep enough history that defaultModel() can fall through to an older choice
  // when the most-recent provider/model is no longer connected.
  export const MAX_RECENT = 50

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
  }

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

  /**
   * Pure: only a user's own top-level prompt seeds the global default model.
   * Automation runs (automationID) and subagent / agent-tool child sessions
   * (parentID / createdByAgentTool) carry their own model and must NOT leak into
   * the default that every fresh session inherits.
   */
  export function shouldRecordRecent(input: {
    automationID?: string
    parentID?: string
    createdByAgentTool?: boolean
  }): boolean {
    return !input.automationID && !input.parentID && !input.createdByAgentTool
  }

  /**
   * Best-effort persist of the user's last-used model. Locked read-modify-write so
   * a concurrent CLI/desktop writer can neither corrupt the file (writeJson is not
   * atomic) nor drop sibling fields. A failure here must never break the prompt.
   */
  export async function recordRecent(model: ModelRef): Promise<void> {
    const file = path.join(Global.Path.state, "model.json")
    try {
      await Flock.withLock(`model-state:${file}`, async () => {
        const current = await Filesystem.readJson<unknown>(file).catch(() => undefined)
        await Filesystem.writeJson(file, applyRecent(current, model))
      })
    } catch {
      // recording recent is best-effort — it must not surface as a prompt failure
    }
  }
}
