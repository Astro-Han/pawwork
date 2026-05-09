import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { DockSegment } from "@opencode-ai/ui/dock-card"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { DockWidgetHeader } from "@/pages/session/composer/dock-widget-header"
import { useDockCollapse } from "@/pages/session/composer/use-dock-collapse"

export function SessionFollowupDock(props: {
  items: { id: string; text: string }[]
  sending?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")
  const collapse = useDockCollapse(() => store.collapsed)

  return (
    <DockSegment
      data-component="session-followup-dock"
      style={{
        "overflow-y": "hidden",
        "max-height": collapse.maxHeight(),
      }}
    >
      <div ref={collapse.setContentRef}>
        <DockWidgetHeader
          onToggle={toggle}
          chev={
            <IconButton
              data-collapsed={store.collapsed ? "true" : "false"}
              icon="chevron-down"
              size="normal"
              variant="ghost"
              style={{ transform: `rotate(${collapse.turn() * 180}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              aria-label={
                store.collapsed
                  ? language.t("session.followupDock.expand")
                  : language.t("session.followupDock.collapse")
              }
            />
          }
        >
          <span class="shrink-0 text-13-medium text-fg-strong cursor-default leading-none">{label()}</span>
          <Show when={store.collapsed && preview()}>
            <span class="min-w-0 flex-1 truncate text-13-regular text-fg-base cursor-default leading-none">
              {preview()}
            </span>
          </Show>
        </DockWidgetHeader>

        <div
          aria-hidden={collapse.off()}
          style={{
            visibility: collapse.off() ? "hidden" : "visible",
            opacity: `${1 - collapse.value()}`,
          }}
        >
          <div class="px-3 pb-2 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar">
            <For each={props.items}>
              {(item) => (
                <div class="h-[30px] flex items-center gap-2 min-w-0">
                  <span class="min-w-0 flex-1 truncate text-13-regular text-fg-strong leading-none">{item.text}</span>
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0"
                    disabled={!!props.sending}
                    onClick={() => props.onSend(item.id)}
                  >
                    {language.t("session.followupDock.sendNow")}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0"
                    disabled={!!props.sending}
                    onClick={() => props.onEdit(item.id)}
                  >
                    {language.t("session.followupDock.edit")}
                  </Button>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </DockSegment>
  )
}
