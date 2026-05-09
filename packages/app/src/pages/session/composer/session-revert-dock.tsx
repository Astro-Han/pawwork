import { For, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockSegment } from "@opencode-ai/ui/dock-card"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { DockWidgetHeader } from "@/pages/session/composer/dock-widget-header"

export function SessionRevertDock(props: {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: true,
  })

  createEffect(() => {
    props.items.length
    props.items[0]?.id
    setStore("collapsed", true)
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.revertDock.summary.one" : "session.revertDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <DockSegment data-component="session-revert-dock">
      <DockWidgetHeader
        onToggle={toggle}
        chev={
          <IconButton
            data-collapsed={store.collapsed ? "true" : "false"}
            icon="chevron-down"
            size="normal"
            variant="ghost"
            style={{ transform: `rotate(${store.collapsed ? 180 : 0}deg)` }}
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              toggle()
            }}
            aria-label={
              store.collapsed ? language.t("session.revertDock.expand") : language.t("session.revertDock.collapse")
            }
          />
        }
      >
        <span class="shrink-0 text-13-regular text-fg-strong cursor-default leading-none">{label()}</span>
        <Show when={store.collapsed && preview()}>
          <span class="min-w-0 flex-1 truncate text-13-regular text-fg-base cursor-default leading-none">
            {preview()}
          </span>
        </Show>
      </DockWidgetHeader>

      <Show when={!store.collapsed}>
        <div class="px-3 pb-3 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
          <For each={props.items}>
            {(item) => (
              <div class="flex items-center gap-2 min-w-0">
                <span class="min-w-0 flex-1 truncate text-13-regular text-fg-strong">{item.text}</span>
                <Button
                  size="small"
                  variant="ghost"
                  class="shrink-0"
                  disabled={props.disabled || !!props.restoring}
                  onClick={() => props.onRestore(item.id)}
                >
                  {language.t("session.revertDock.restore")}
                </Button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </DockSegment>
  )
}
