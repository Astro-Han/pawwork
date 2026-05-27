import { createMemo, createSignal, Show } from "solid-js"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"

export function AssistantTurnFooter(props: {
  text: string
  message: AssistantMessage
  turnDurationMs?: number
}) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const [copied, setCopied] = createSignal(false)

  const interrupted = createMemo(() => props.message.error?.name === "MessageAbortedError")

  const model = createMemo(() => {
    const match = data.store.provider?.all?.find((p) => p.id === props.message.providerID)
    return match?.models?.[props.message.modelID]?.name ?? props.message.modelID
  })

  const duration = createMemo(() => {
    const completed = props.message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - props.message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const meta = createMemo(() => {
    const agent = props.message.agent
    const items = [
      agent ? agent[0]?.toUpperCase() + agent.slice(1) : "",
      model(),
      duration(),
      interrupted() ? i18n.t("ui.message.interrupted") : "",
    ]
    return items.filter((x) => !!x).join(" · ")
  })

  const handleCopy = async () => {
    const content = props.text
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div data-slot="assistant-turn-footer">
      <Tooltip
        value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
        placement="top"
        gutter={4}
      >
        <IconButton
          icon={copied() ? "check" : "copy"}
          size="normal"
          variant="ghost"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCopy}
          aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyResponse")}
        />
      </Tooltip>
      <Show when={meta()}>
        <span data-slot="assistant-turn-footer-meta" class="text-body text-fg-weak cursor-default">
          {meta()}
        </span>
      </Show>
    </div>
  )
}
