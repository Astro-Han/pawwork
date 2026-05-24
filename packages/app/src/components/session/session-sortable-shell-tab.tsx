import { Show, type JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { Icon } from "@opencode-ai/ui/icon"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { RightPanelTab } from "@/pages/session/right-panel-tabs"

/**
 * Right-panel shell tab. Renders as `icon + label`; on a closable tab, hovering
 * the leading icon swaps it in place for a close-small × — same 14×14 slot, no
 * layout shift, so closable and non-closable tabs share an identical resting
 * width. The active tab is marked by a 2px brand underline (handled in
 * packages/ui/src/components/tabs.css for `data-variant="sidepanel"`) — chip
 * backgrounds are intentionally absent so the strip reads as titlebar chrome
 * rather than a competing toolbar.
 *
 * Click target rules:
 *  - Click on the icon area:
 *      • closable + hovered → close (stopPropagation, so Tabs.Trigger doesn't
 *        also fire the value-change).
 *      • otherwise           → falls through to Tabs.Trigger, selecting the tab.
 *  - Click anywhere else on the tab → Tabs.Trigger handles the selection.
 *  - Middle-click anywhere → close (existing onMiddleClick contract).
 */
export function ShellTab(props: {
  value: RightPanelTab
  label: string
  closable: boolean
  onClose: (tab: RightPanelTab) => void
  icon: JSX.Element
}): JSX.Element {
  const language = useLanguage()
  const close = () => {
    if (!props.closable) return
    props.onClose(props.value)
  }

  // Gate the close to "the × glyph is actually showing." The default icon and
  // the close × overlay live in the same 14×14 cell — CSS swaps which is
  // visible via :hover (see tabs.css `data-closable` rule). Without the
  // :hover guard, ANY click on a closable tab's icon area closes the tab,
  // which blocks selection-by-icon — see CodeRabbit feedback on PR #878.
  let swapRef: HTMLSpanElement | undefined
  const swap = (
    <span
      ref={swapRef}
      data-slot="tab-icon-swap"
      data-closable={props.closable || undefined}
      class="relative inline-flex items-center justify-center size-3.5"
      onClick={(event) => {
        if (!props.closable) return
        // Only intercept when the × is the visible glyph (hover state). Otherwise
        // let the click bubble to Tabs.Trigger so the tab gets selected.
        if (!swapRef?.matches(":hover")) return
        event.stopPropagation()
        event.preventDefault()
        close()
      }}
    >
      <span
        data-slot="tab-icon-default"
        class="absolute inset-0 inline-flex items-center justify-center transition-opacity duration-100"
      >
        {props.icon}
      </span>
      <Show when={props.closable}>
        <span
          data-slot="tab-icon-close"
          class="absolute inset-0 inline-flex items-center justify-center opacity-0 transition-opacity duration-100"
        >
          <Icon name="close-small" class="text-fg-weak" />
        </span>
      </Show>
    </span>
  )

  return (
    <div class="h-full flex items-center">
      <Tabs.Trigger
        value={props.value}
        class="shrink-0 h-full"
        classes={{
          button:
            "h-7 min-h-7 inline-flex items-center whitespace-nowrap rounded-md text-h3 text-fg-weak gap-1.5 px-2.5",
        }}
        onMiddleClick={close}
        aria-label={props.label}
      >
        <Show when={props.closable} fallback={swap}>
          <Tooltip value={language.t("common.closeTab")} placement="bottom" gutter={10} openDelay={400}>
            {swap}
          </Tooltip>
        </Show>
        <span>{props.label}</span>
      </Tabs.Trigger>
    </div>
  )
}

export function SortableShellTab(props: {
  value: RightPanelTab
  label: string
  closable: boolean
  onClose: (tab: RightPanelTab) => void
  icon: JSX.Element
}): JSX.Element {
  const sortable = createSortable(props.value)

  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <ShellTab {...props} />
    </div>
  )
}
