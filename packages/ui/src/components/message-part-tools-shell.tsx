import { createMemo, createSignal, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { BasicTool } from "./basic-tool"
import { Tooltip } from "./tooltip"
import { IconButton } from "./icon-button"
import { TextShimmer } from "./text-shimmer"
import { ToolRegistry } from "./message-part-registry"
import { ShellSubmessage } from "./message-part-tool-display"
import { normalizeShellOutput } from "../util/shell-output"

/**
 * Slice 11b.1: bash tool renderer extracted from `message-part.tsx`.
 * Owns its own copy-to-clipboard state, animated subtitle (via the
 * shared `ShellSubmessage` primitive), and scrollable pre output.
 *
 * No shared helpers across this and the file renderers (apply_patch
 * etc.) — bash is shell output, not file diff, so they intentionally
 * stay decoupled.
 */

ToolRegistry.register({
  name: "bash",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = normalizeShellOutput(props.output || props.metadata.output || "")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <TextShimmer text={i18n.t("ui.tool.shell")} active={pending()} />
              </span>
              <Show when={!pending() && props.input.description}>
                <ShellSubmessage text={props.input.description} animate={sawPending} />
              </Show>
            </div>
          </div>
        }
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <Tooltip
              value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              placement="top"
              gutter={4}
            >
              <IconButton
                icon={copied() ? "check" : "copy"}
                size="small"
                variant="secondary"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </Tooltip>
          </div>
          <div data-slot="bash-scroll" data-scrollable>
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})
