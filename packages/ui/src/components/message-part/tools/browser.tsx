import { createMemo, Show } from "solid-js"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { toolIcon } from "../../tool-info"
import { Icon } from "../../icon"
import { TextShimmer } from "../../text-shimmer"
import { ToolRegistry } from "../registry"
import type { ToolProps } from "../registry"

/**
 * Cards for the seven browser_* tools. Compact rows by default; snapshot and
 * extract expand to the text the agent actually read (reusing the bash-output
 * slots so scrolling/copy styling stays consistent).
 */

function isPending(status?: string) {
  return status === "pending" || status === "running"
}

function safeHttpUrl(value: unknown): string {
  if (typeof value !== "string") return ""
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""
    return parsed.toString()
  } catch {
    return ""
  }
}

function TextOutput(props: { output?: string }) {
  return (
    <Show when={props.output}>
      <div data-component="bash-output">
        <div data-slot="bash-scroll" data-scrollable>
          <pre data-slot="bash-pre">
            <code>{props.output}</code>
          </pre>
        </div>
      </div>
    </Show>
  )
}

/** Compact row: localized title + a literal subtitle (ref, url, condition). */
function row(name: string, titleKey: Parameters<ReturnType<typeof useI18n>["t"]>[0], subtitle: (props: ToolProps) => string | undefined, details?: boolean) {
  ToolRegistry.register({
    name,
    render(props) {
      const i18n = useI18n()
      const pending = createMemo(() => isPending(props.status))
      return (
        <BasicTool
          {...props}
          hideDetails={!details}
          icon={toolIcon(name)}
          trigger={
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">
                  <TextShimmer text={i18n.t(titleKey)} active={pending()} />
                </span>
                <Show when={subtitle(props)}>
                  <span data-slot="basic-tool-tool-subtitle">{subtitle(props)}</span>
                </Show>
              </div>
            </div>
          }
        >
          {details ? <TextOutput output={props.output} /> : undefined}
        </BasicTool>
      )
    },
  })
}

// navigate gets a clickable link like webfetch.
ToolRegistry.register({
  name: "browser_navigate",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => isPending(props.status))
    const url = createMemo(() => safeHttpUrl(props.metadata?.url ?? props.input.url))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon={toolIcon("browser_navigate")}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.browser.navigate")} active={pending()} />
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

row("browser_snapshot", "ui.tool.browser.snapshot", (props) => safeHttpUrl(props.metadata?.url), true)
row("browser_click", "ui.tool.browser.click", (props) =>
  typeof props.input.ref === "string" ? props.input.ref : undefined,
)
row("browser_type", "ui.tool.browser.type", (props) =>
  typeof props.input.ref === "string" ? props.input.ref : undefined,
)
row("browser_wait", "ui.tool.browser.wait", (props) => {
  if (typeof props.input.text === "string") return props.input.text
  if (typeof props.input.selector === "string") return props.input.selector
  if (typeof props.input.time === "number") return `${props.input.time}s`
  return undefined
})
row("browser_screenshot", "ui.tool.browser.screenshot", (props) => safeHttpUrl(props.metadata?.url))
row("browser_extract", "ui.tool.browser.extract", (props) =>
  typeof props.input.selector === "string" ? props.input.selector : safeHttpUrl(props.metadata?.url),
  true,
)
