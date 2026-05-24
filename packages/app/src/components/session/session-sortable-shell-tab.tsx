import { Show, type JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import type { RightPanelTab } from "@/pages/session/right-panel-tabs"

/**
 * Right-panel shell tab. Renders as `icon + label` at rest. On a closable tab
 * the leading icon cell and the close button occupy the same 14x14 absolute
 * position — CSS fades the close button in and the icon out on wrapper hover,
 * with no layout shift. Closable tabs follow the ARIA APG closable-tabs
 * pattern: Delete/Backspace on the focused trigger closes the tab, the
 * `closeButton` slot renders a real semantic button (tabIndex=-1, no extra
 * Tab stop), and right-click shows a context menu with the close action.
 *
 * Close affordances:
 * - mouse hover reveals × (visible affordance)
 * - Delete/Backspace key on the focused tab (advertised via aria-keyshortcuts)
 * - middle-click on the tab
 * - mod+w global command (`tab.close`)
 * - right-click / Shift+F10 context menu with "Close tab" item
 *
 * Why no focus-within swap: keyboard arrow navigation moves focus across
 * every tab; swapping each focused tab's icon to × on the way past would
 * be visually noisy. Keyboard users do not need to see the × — Delete works
 * regardless of which glyph is rendered.
 *
 * See ARIA APG "Tabs with Manual Activation" for the Delete-key pattern.
 */
export function ShellTab(props: {
  value: RightPanelTab
  label: string
  closable: boolean
  onClose: (tab: RightPanelTab) => void
  icon: JSX.Element
}): JSX.Element {
  const language = useLanguage()
  const command = useCommand()

  // Ref to my outer container; the actual `[data-slot="tabs-trigger-wrapper"]`
  // (rendered inside Tabs.Trigger) is a descendant — we look it up via query
  // rather than wiring a separate ref into the UI primitive.
  let containerRef: HTMLDivElement | undefined

  const close = () => {
    if (!props.closable) return

    // Focus management: find next/prev sibling tab trigger BEFORE removing this
    // tab from the DOM, then restore focus after Solid commits the removal.
    let focusTarget: HTMLElement | null = null
    const ownWrapper = containerRef?.querySelector<HTMLElement>('[data-slot="tabs-trigger-wrapper"]')
    const tablist = ownWrapper?.closest('[data-slot="tabs-list"]')
    if (ownWrapper && tablist) {
      const wrappers = Array.from(
        tablist.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger-wrapper"]'),
      )
      const index = wrappers.indexOf(ownWrapper)
      if (index !== -1) {
        // Prefer next sibling; fall back to prev sibling.
        const candidate = wrappers[index + 1] ?? wrappers[index - 1]
        focusTarget = candidate?.querySelector<HTMLElement>('[data-slot="tabs-trigger"]') ?? null
      }
    }

    props.onClose(props.value)

    // Wait one tick for Solid to commit the DOM removal, then restore focus.
    if (focusTarget) {
      requestAnimationFrame(() => {
        focusTarget?.focus()
      })
    }
  }

  // The leading icon is rendered as a plain non-interactive span. In the
  // closable case, the closeButton slot sits absolutely on top at the same
  // position and is revealed on hover/focus-within (see tabs.css sidepanel rules).
  const iconSpan = (
    <span data-slot="tab-icon-default" class="inline-flex items-center justify-center size-3.5">
      {props.icon}
    </span>
  )

  const tabTrigger = (
    <Tabs.Trigger
      value={props.value}
      class="shrink-0 h-full"
      classes={{
        // Spacing (gap, padding-inline, border-radius) lives in tabs.css under
        // the sidepanel variant so it rides on `--space-sm` (8px) and
        // `--radius-lg` (14px) tokens. Tailwind utilities are kept out here
        // because the app pins `html { font-size: 13px }`, which makes the
        // default rem-based spacing scale drift off the 4pt grid (gap-2 =
        // 0.5rem = 6.5px instead of 8px). Routing through CSS variables in
        // the variant block keeps the chip exactly on the grid.
        button: "h-7 min-h-7 inline-flex items-center whitespace-nowrap text-h3 text-fg-weak",
      }}
      onMiddleClick={close}
      aria-label={props.label}
      // Advertise the Delete key shortcut to assistive technology — only on
      // closable tabs, since Status's onKeyDown is a no-op and exposing the
      // shortcut there would be a false promise.
      aria-keyshortcuts={props.closable ? "Delete" : undefined}
      onKeyDown={
        props.closable
          ? (event: KeyboardEvent) => {
              // ARIA APG closable-tabs pattern: Delete (or Backspace as the
              // macOS alias) on a focused closable trigger closes the tab.
              if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault()
                close()
              }
            }
          : undefined
      }
      // Only pass the slot when closable — passing `<Show when={false}>` would
      // still render an empty `[data-slot="tabs-trigger-close-button"]` div
      // (Tabs.Trigger's outer Show checks truthiness of the JSX value, not the
      // inner Show's condition), which would let the hover/focus-within CSS
      // rules fade out the Status tab's icon with nothing to replace it.
      closeButton={
        props.closable ? (
          <TooltipKeybind
            title={language.t("common.closeTab")}
            keybind={command.keybind("tab.close")}
            placement="bottom"
            gutter={10}
          >
            <IconButton
              icon="close-small"
              variant="ghost"
              class="h-3.5 w-3.5"
              // tabIndex=-1 keeps this out of the Tab order; the trigger itself
              // is the focusable unit, and Delete/Backspace handles keyboard close.
              tabIndex={-1}
              aria-label={`Close ${props.label} tab`}
              onClick={() => close()}
            />
          </TooltipKeybind>
        ) : undefined
      }
    >
      {iconSpan}
      <span>{props.label}</span>
    </Tabs.Trigger>
  )

  return (
    <div ref={containerRef} class="h-full flex items-center">
      <Show
        when={props.closable}
        fallback={tabTrigger}
      >
        <ContextMenu>
          <ContextMenu.Trigger as="div" class="h-full flex items-center">
            {tabTrigger}
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content>
              <ContextMenu.Item onSelect={() => close()}>
                <ContextMenu.ItemLabel>{language.t("common.closeTab")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu>
      </Show>
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
