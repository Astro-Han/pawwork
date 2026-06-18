import { Match, Switch, createMemo } from "solid-js"
import type { NoticePart } from "@opencode-ai/sdk/v2"
import { useData } from "../../../context"
import { useI18n } from "../../../context/i18n"
import { Icon } from "../../icon"
import { registerPartComponent } from "../registry"
import "./notice.css"

// Mirrors the backend READ_ONLY_TOOLS set (run-observability/sanitize.ts): these
// tools have no external side effect. Any other tool — bash, apply_patch, or an
// unknown/custom one — is treated as side-effecting.
const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "webfetch", "tool_info"])

registerPartComponent("notice", function NoticePartDisplay(props) {
  const i18n = useI18n()
  const data = useData()
  const part = () => props.part as NoticePart

  // A completed *side-effecting* tool earlier in the same turn means an external
  // action already landed (e.g. a posted comment). Reassure the user it is done
  // and not to redo it; otherwise the model's reply simply never started. Only
  // non-read-only tools qualify: read/glob/grep/webfetch/tool_info carry no side
  // effect (mirrors the backend READ_ONLY_TOOLS set in run-observability/
  // sanitize.ts), so a completed grep must not falsely claim an action landed.
  // Everything else — bash, apply_patch, or an unknown/custom tool — counts,
  // erring toward reassurance so a real side effect is never under-warned.
  const afterSideEffectingTool = createMemo(() => {
    const parts = data.store.part?.[part().messageID]
    return (
      Array.isArray(parts) &&
      parts.some((p) => p.type === "tool" && p.state.status === "completed" && !READ_ONLY_TOOLS.has(p.tool))
    )
  })

  return (
    <Switch>
      <Match when={part().kind === "safe_retry_failed"}>
        <div
          data-component="notice-part"
          data-kind="safe_retry_failed"
          data-variant={afterSideEffectingTool() ? "side-effect" : "default"}
        >
          <span data-slot="notice-icon">
            <Icon name="warning" />
          </span>
          <div data-slot="notice-text">
            <div data-slot="notice-title">
              {afterSideEffectingTool()
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.title")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.title")}
            </div>
            <div data-slot="notice-body">
              {afterSideEffectingTool()
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.body")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.body")}
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
})
