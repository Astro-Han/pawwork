import { Component, For, Show } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/util/path"
import type { ContextItem } from "@/context/prompt"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  t: (key: string) => string
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
            const range = () => {
              const sel = item.selection
              if (!sel) return ""
              return sel.startLine === sel.endLine ? `:${sel.startLine}` : `:${sel.startLine}-${sel.endLine}`
            }

            return (
              <Tooltip
                value={
                  <span class="flex flex-col gap-0.5 max-w-[300px]">
                    <span class="flex">
                      <span class="text-fg-on-brand truncate-start [unicode-bidi:plaintext] min-w-0">{directory}</span>
                      <span class="shrink-0">{filename}</span>
                    </span>
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
                  classList={{
                    "group inline-flex shrink-0 items-center gap-1 cursor-default transition-colors": true,
                    "h-[24px] rounded-full pl-2 pr-1 max-w-[200px]": true,
                    "bg-surface-interactive-hover": selected,
                    "bg-bg-weak hover:bg-surface-interactive-base": !selected,
                  }}
                  style={{
                    font: "var(--type-mono-small)",
                    color: "var(--fg-base)",
                    "white-space": "nowrap",
                  }}
                  onClick={() => props.openComment(item)}
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
