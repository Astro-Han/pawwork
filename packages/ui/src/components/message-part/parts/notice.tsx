import { Match, Switch } from "solid-js"
import type { NoticePart } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../../context/i18n"
import { registerPartComponent } from "../registry"

registerPartComponent("notice", function NoticePartDisplay(props) {
  const i18n = useI18n()
  const part = () => props.part as NoticePart

  return (
    <Switch>
      <Match when={part().kind === "safe_retry_failed"}>
        <div data-component="notice-part" data-kind="safe_retry_failed" class="text-text-muted text-sm">
          {i18n.t("ui.sessionTurn.notice.safeRetryFailed")}
        </div>
      </Match>
    </Switch>
  )
})
