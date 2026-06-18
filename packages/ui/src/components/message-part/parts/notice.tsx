import { Match, Switch, createMemo } from "solid-js"
import type { NoticePart } from "@opencode-ai/sdk/v2"
import { useData } from "../../../context"
import { useI18n } from "../../../context/i18n"
import { Icon } from "../../icon"
import { registerPartComponent } from "../registry"
import "./notice.css"

registerPartComponent("notice", function NoticePartDisplay(props) {
  const i18n = useI18n()
  const data = useData()
  const part = () => props.part as NoticePart

  // A completed tool earlier in the same turn means an external side effect
  // already landed (e.g. a posted comment). Reassure the user it is done and
  // not to redo it; otherwise the model's reply simply never started. Any
  // completed tool qualifies — this can only over-apply the reassuring copy to
  // a read-only turn (harmless), never miss a real side effect.
  const afterToolRun = createMemo(() => {
    const parts = data.store.part?.[part().messageID]
    return Array.isArray(parts) && parts.some((p) => p.type === "tool" && p.state.status === "completed")
  })

  return (
    <Switch>
      <Match when={part().kind === "safe_retry_failed"}>
        <div
          data-component="notice-part"
          data-kind="safe_retry_failed"
          data-variant={afterToolRun() ? "side-effect" : "default"}
        >
          <span data-slot="notice-icon">
            <Icon name="warning" />
          </span>
          <div data-slot="notice-text">
            <div data-slot="notice-title">
              {afterToolRun()
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.title")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.title")}
            </div>
            <div data-slot="notice-body">
              {afterToolRun()
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.body")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.body")}
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
})
