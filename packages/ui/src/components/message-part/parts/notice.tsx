import { Match, Switch } from "solid-js"
import type { NoticePart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../../context/i18n"
import { Icon } from "../../icon"
import { registerPartComponent } from "../registry"
import "./notice.css"

registerPartComponent("notice", function NoticePartDisplay(props) {
  const i18n = useI18n()
  const part = () => props.part as NoticePart

  // `sideEffect` is set by the backend when a side-effecting tool already
  // completed earlier in this turn — possibly on a sibling assistant message,
  // since the post-tool continuation runs as a new message (#1358). The UI can't
  // see sibling messages and must not reclassify tools, so it trusts the field:
  // true → reassure the action landed and not to redo it; false → the reply
  // simply never started.
  return (
    <Switch>
      <Match when={part().kind === "safe_retry_failed"}>
        <div
          data-component="notice-part"
          data-kind="safe_retry_failed"
          data-variant={part().sideEffect ? "side-effect" : "default"}
        >
          <span data-slot="notice-icon">
            <Icon name="warning" />
          </span>
          <div data-slot="notice-text">
            <div data-slot="notice-title">
              {part().sideEffect
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.title")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.title")}
            </div>
            <div data-slot="notice-body">
              {part().sideEffect
                ? i18n.t("ui.sessionTurn.notice.safeRetryFailed.sideEffect.body")
                : i18n.t("ui.sessionTurn.notice.safeRetryFailed.default.body")}
            </div>
          </div>
        </div>
      </Match>
    </Switch>
  )
})
