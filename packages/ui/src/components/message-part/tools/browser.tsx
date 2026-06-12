import { createMemo, Show } from "solid-js"
import { useDialog } from "../../../context/dialog"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { ImagePreview } from "../../image-preview"
import { BROWSER_TOOL_TITLE_KEYS, browserToolSubtitle, toolIcon } from "../../tool-info"
import { Icon } from "../../icon"
import { TextShimmer } from "../../text-shimmer"
import { ToolRegistry } from "../registry"
import type { ToolProps } from "../registry"

/**
 * Cards for the seven browser_* tools. Compact rows by default; snapshot and
 * extract expand to the text the agent actually read (reusing the bash-output
 * slots so scrolling/copy styling stays consistent), and screenshot expands to
 * the captured image itself. Titles and subtitles come from tool-info.ts —
 * the same source the collapsed trow summary uses — so the two surfaces never
 * drift.
 */

function isPending(status?: string) {
  return status === "pending" || status === "running"
}

function subtitleOf(name: string, props: ToolProps): string | undefined {
  return browserToolSubtitle(name, props.input, props.metadata)
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
function row(name: keyof typeof BROWSER_TOOL_TITLE_KEYS, details?: boolean) {
  ToolRegistry.register({
    name,
    render(props) {
      const i18n = useI18n()
      const pending = createMemo(() => isPending(props.status))
      const subtitle = createMemo(() => subtitleOf(name, props))
      return (
        <BasicTool
          {...props}
          hideDetails={!details}
          icon={toolIcon(name)}
          trigger={
            <div data-slot="basic-tool-tool-info-structured">
              <div data-slot="basic-tool-tool-info-main">
                <span data-slot="basic-tool-tool-title">
                  <TextShimmer text={i18n.t(BROWSER_TOOL_TITLE_KEYS[name])} active={pending()} />
                </span>
                <Show when={subtitle()}>
                  <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
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
    const url = createMemo(() => subtitleOf("browser_navigate", props))
    return (
      <BasicTool
        {...props}
        hideDetails
        icon={toolIcon("browser_navigate")}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t(BROWSER_TOOL_TITLE_KEYS.browser_navigate)} active={pending()} />
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

row("browser_snapshot", true)
row("browser_click")
row("browser_type")
row("browser_wait")
// screenshot expands to the captured image (an attached data: PNG); clicking
// it opens the full-size preview dialog like user-message image attachments.
ToolRegistry.register({
  name: "browser_screenshot",
  render(props) {
    const i18n = useI18n()
    const dialog = useDialog()
    const pending = createMemo(() => isPending(props.status))
    const image = createMemo(() => {
      const url = props.attachments?.find((file) => file.mime?.startsWith("image/"))?.url
      // Tool-attached screenshots are inline data: images; anything else is unexpected — drop it.
      return typeof url === "string" && url.startsWith("data:image/") ? url : ""
    })
    const subtitle = createMemo(() => subtitleOf("browser_screenshot", props))
    return (
      <BasicTool
        {...props}
        hideDetails={!image()}
        icon={toolIcon("browser_screenshot")}
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t(BROWSER_TOOL_TITLE_KEYS.browser_screenshot)} active={pending()} />
              </span>
              <Show when={subtitle()}>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </Show>
            </div>
          </div>
        }
      >
        <Show when={image()}>
          <div data-component="browser-screenshot">
            <img
              src={image()}
              alt={i18n.t(BROWSER_TOOL_TITLE_KEYS.browser_screenshot)}
              onClick={() =>
                dialog.show(() => (
                  <ImagePreview src={image()} alt={i18n.t(BROWSER_TOOL_TITLE_KEYS.browser_screenshot)} />
                ))
              }
            />
          </div>
        </Show>
      </BasicTool>
    )
  },
})
row("browser_extract", true)
