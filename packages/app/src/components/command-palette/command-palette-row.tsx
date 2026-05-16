import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { getDirectory, getFilename } from "@opencode-ai/util/path"
import { Match, Show, Switch } from "solid-js"
import { formatKeybind } from "@/context/command"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import type { CommandPaletteEntry } from "./command-palette-types"

export function CommandPaletteRow(props: { item: CommandPaletteEntry }) {
  const language = useLanguage()
  const item = () => props.item

  return (
    <Switch
      fallback={
        <div class="w-full flex items-center justify-between rounded-md pl-1">
          <div class="flex items-center gap-x-3 grow min-w-0">
            <FileIcon node={{ path: item().path ?? "", type: "file" }} class="shrink-0 size-4" />
            <div class="flex items-center text-body">
              <span class="text-fg-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                {getDirectory(item().path ?? "")}
              </span>
              <span class="text-fg-strong whitespace-nowrap">{getFilename(item().path ?? "")}</span>
            </div>
          </div>
        </div>
      }
    >
      <Match when={item().type === "command"}>
        <div class="w-full flex items-center justify-between gap-4">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-body text-fg-strong whitespace-nowrap">{item().title}</span>
            <Show when={item().description}>
              <span class="text-body text-fg-weak truncate">{item().description}</span>
            </Show>
          </div>
          <Show when={item().keybind}>
            <Keybind class="rounded-[4px]">{formatKeybind(item().keybind ?? "", language.t)}</Keybind>
          </Show>
        </div>
      </Match>
      <Match when={item().type === "session"}>
        <div class="w-full flex items-center justify-between rounded-md pl-1">
          <div class="flex items-center gap-x-3 grow min-w-0">
            <Icon name="bubble-5" class="shrink-0 text-icon-weak" />
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-body text-fg-strong truncate" classList={{ "opacity-70": !!item().archived }}>
                {item().title}
              </span>
              <Show when={item().description}>
                <span
                  class="text-body text-fg-weak truncate"
                  classList={{ "opacity-70": !!item().archived }}
                >
                  {item().description}
                </span>
              </Show>
            </div>
          </div>
          <Show when={item().updated}>
            <span class="text-body text-fg-weak whitespace-nowrap ml-2">
              {getRelativeTime(new Date(item().updated!).toISOString(), language.t)}
            </span>
          </Show>
        </div>
      </Match>
    </Switch>
  )
}
