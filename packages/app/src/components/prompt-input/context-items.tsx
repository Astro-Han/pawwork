import { Component, For, Show } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/util/path"
import type { ContextItem } from "@/context/prompt"
import { isExternalChip } from "./path-canonical"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  t: (key: string) => string
  /** Workspace root directory; used to detect external absolute-path chips. */
  sourceFilesystemDirectory?: string
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  return (
    <Show when={props.items.length > 0}>
      <div class="flex flex-nowrap items-center gap-2 px-3 pt-3 overflow-x-auto no-scrollbar">
        <For each={props.items}>
          {(item) => {
            const directory = getDirectory(item.path)
            const filename = getFilename(item.path)
            const label = getFilenameTruncated(item.path, 18)
            const selected = props.active(item)
            const external = isExternalChip(item.path, props.sourceFilesystemDirectory)
            const range = () => {
              const sel = item.selection
              if (!sel) return ""
              return sel.startLine === sel.endLine ? `:${sel.startLine}` : `:${sel.startLine}-${sel.endLine}`
            }

            return (
              <Tooltip
                value={
                  <span class="flex flex-col gap-0.5 max-w-[300px]">
                    <Show when={external}>
                      <span class="text-fg-on-brand opacity-80 text-xs">
                        {props.t("prompt.context.externalFile")} · {item.path}
                      </span>
                    </Show>
                    <Show when={!external}>
                      <span class="flex">
                        <span class="text-fg-on-brand truncate-start [unicode-bidi:plaintext] min-w-0">{directory}</span>
                        <span class="shrink-0">{filename}</span>
                      </span>
                    </Show>
                    <Show when={item.comment}>
                      {(comment) => <span class="text-fg-on-brand opacity-80 break-words">{comment()}</span>}
                    </Show>
                  </span>
                }
                placement="top"
                openDelay={400}
              >
                <div
                  data-component="prompt-context-chip"
                  data-selected={selected ? "" : undefined}
                  data-external={external ? "" : undefined}
                  classList={{
                    "group inline-flex shrink-0 items-center gap-1 transition-colors": true,
                    "h-[26px] rounded-full pl-2 pr-1 max-w-[200px]": true,
                    "cursor-not-allowed opacity-70": external,
                    "cursor-default": !external,
                    "bg-surface-interactive-hover": selected && !external,
                    "bg-bg-weak hover:bg-surface-interactive-base": !selected && !external,
                    "bg-bg-weak": external,
                  }}
                  style={{
                    "font-family": "var(--font-family-mono)",
                    "font-size": "var(--font-size-mono-small)",
                    "font-weight": "var(--font-weight-mono-small)",
                    "line-height": "var(--line-height-mono-small)",
                    color: "var(--fg-base)",
                    "white-space": "nowrap",
                  }}
                  onClick={(event) => {
                    // External chips: path is outside current workspace; block navigation.
                    if (external) {
                      event.preventDefault()
                      return
                    }
                    props.openComment(item)
                  }}
                >
                  <FileIcon
                    node={{ path: item.path, type: "file" }}
                    class="shrink-0 size-4"
                    style={{ color: "var(--icon-weak)" }}
                  />
                  <span class="min-w-0 overflow-hidden text-ellipsis">
                    <span class="text-fg-strong">{label}</span>
                    <Show when={item.selection}>
                      <span class="text-fg-weak">{range()}</span>
                    </Show>
                  </span>
                  <button
                    type="button"
                    class="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-weak hover:bg-row-active-overlay hover:text-fg-strong"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.remove(item)
                    }}
                    aria-label={props.t("prompt.context.removeFile")}
                  >
                    <Icon name="close" class="size-4" />
                  </button>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
