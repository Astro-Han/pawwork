import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"
import { isRecord } from "../util/record"

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
   * Pure: only a user's own explicit model choice seeds the global default model.
   * Automation runs (automationID), subagent / agent-tool child sessions
   * (parentID / createdByAgentTool), and slash-command invocations (fromCommand)
   * carry their own model and must NOT leak into the default that every fresh
   * session inherits. A command resolves its own (often pinned) utility model and
   * reuses the prompt path, so without this guard a `/commit`-style command could
   * silently become the model a later Telegram `/new` defaults to.
   *
   * modelFromAgent closes the same hole for the desktop UI: it always sends a
   * resolved model with every prompt, and that model can be the selected agent's
   * configured model rather than a model-picker choice (the renderer's model
   * falls back to the agent's pin). Recording it would let an agent's utility
   * model become the inherited default — exactly the pollution this guards. So
   * a model that merely equals the agent's own configured model does not count
   * as an explicit selection.
   */
  export function shouldRecordRecent(input: {
    automationID?: string
    parentID?: string
    createdByAgentTool?: boolean
    fromCommand?: boolean
    modelFromAgent?: boolean
  }): boolean {
    return (
      !input.automationID &&
      !input.parentID &&
      !input.createdByAgentTool &&
      !input.fromCommand &&
      !input.modelFromAgent
    )
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
