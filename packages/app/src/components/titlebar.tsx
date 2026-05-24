import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"

import { useLayout } from "@/context/layout"
import { isDesktopShell, isMacShell, isWindowsShell, shellAttrs, usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { applyPath, backPath, forwardPath } from "./titlebar-history"

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()

  const mac = createMemo(() => isMacShell(platform))
  const windows = createMemo(() => isWindowsShell(platform))
  const zoom = () => platform.webviewZoom?.() ?? 1
  const currentTitlebarHeight = () =>
    mac() ? "var(--shell-titlebar-current-height, var(--shell-titlebar-height, 44px))" : undefined
  const leftPortalStyle = () => ({
    left: "max(172px, calc(var(--sidebar-width, 0px) + 16px))",
    right: "calc(var(--right-panel-width, 0px) + 52px)",
  })

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-component="titlebar-shell"
      data-platform={platform.platform}
      {...shellAttrs(platform)}
      class="shrink-0 relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      classList={{ "h-11": isDesktopShell(platform) && !mac() }}
      style={{ height: currentTitlebarHeight(), "min-height": currentTitlebarHeight() }}
      data-shell-drag-region={!windows() || undefined}
    >
      <div
        classList={{
          "flex items-center min-w-0": true,
          "pl-2": !mac(),
        }}
      >
        <Show when={mac()}>
          <div class="h-full shrink-0" style={{ width: `${72 / zoom()}px` }} />
        </Show>
        <div class="flex items-center gap-1 shrink-0">
          <TooltipKeybind
            class="flex shrink-0 ml-2"
            placement="bottom"
            title={language.t("command.sidebar.toggle")}
            keybind={command.keybind("sidebar.toggle")}
          >
            <Button
              variant="ghost"
              class="group/sidebar-toggle titlebar-icon w-8 h-[30px] p-0 box-border"
              onClick={layout.sidebar.toggle}
              aria-label={language.t("command.sidebar.toggle")}
              aria-expanded={layout.sidebar.opened()}
              data-action="pawwork-sidebar-toggle"
            >
              <Icon name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
            </Button>
          </TooltipKeybind>
          <Show when={params.dir && !layout.sidebar.opened()}>
            <TooltipKeybind
              placement="bottom"
              title={language.t("command.session.new")}
              keybind={command.keybind("session.new")}
              openDelay={2000}
            >
              <Button
                variant="ghost"
                icon="new-session"
                class="titlebar-icon w-8 h-[30px] p-0 box-border"
                onClick={() => {
                  if (!params.dir) return
                  navigate(`/${params.dir}/session`)
                }}
                aria-label={language.t("command.session.new")}
              />
            </TooltipKeybind>
          </Show>
        </div>
      </div>

      <div
        id="pawwork-titlebar-left"
        data-shell-slot="left-portal"
        class="@container pointer-events-none absolute inset-y-0 z-10 flex min-w-0 items-center gap-3 overflow-hidden"
        style={leftPortalStyle()}
      />

      <div class="min-w-0 flex items-center justify-center pointer-events-none">
        <div id="pawwork-titlebar-center" class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full" />
      </div>

      <div
        classList={{
          "flex items-center min-w-0 justify-end": true,
          "pr-2": !windows(),
        }}
      >
        <div
          id="pawwork-titlebar-right"
          data-shell-slot="right-portal"
          class="flex items-center gap-1 shrink-0 justify-end"
        />
      </div>

      {/* Portal slot for the right-panel tab bar. Lives inside the titlebar so the
          tabs read as part of the window chrome rather than a second toolbar
          beneath it. The slot sits directly above the right-panel body — same
          width (`var(--right-panel-width)`) and anchored to the viewport's right
          edge (`right: 0`). `border-l` puts the 1px on the slot's left edge,
          which is the same x as `right-panel-body`'s `border-l` immediately
          below it, so the two read as one continuous separator from titlebar
          top to viewport bottom.

          The `data-component="tabs"` + `data-variant="sidepanel"` + `data-scope`
          + `data-orientation` attributes mirror what <Tabs variant="sidepanel">
          renders on its root. Portalling Tabs.List takes it out of that ancestor,
          so the CSS in packages/ui/src/components/tabs.css (which uses descendant
          selectors like `[data-component="tabs"] [data-slot="tabs-list"]`) would
          otherwise miss it — no flex, no height, no sidepanel hover/selected
          colors. Stamping the same data attrs here lets all existing selectors
          re-match without forking the stylesheet.

          `flex-row` is intentional and not redundant: the same `[data-component="tabs"]`
          rule that we are inheriting also sets `flex-direction: column` on the host
          (it expects to wrap Tabs.List + Tabs.Content vertically). Without an explicit
          override, the slot ends up as a column flex container and `items-center` would
          align its single child horizontally instead of vertically, leaving the tabs
          glued to the top of the titlebar.

          Only populated when the right panel is open (SessionSidePanel guards its Portal). */}
      {/* The slot is a portal landing pad, not a real Tabs root. It stamps
          `data-component="tabs"` only so the existing sidepanel descendant
          selectors in `packages/ui/src/components/tabs.css` still match the
          portalled `Tabs.List`. Two consequences flow from that "borrowed
          identity":
          - Click occlusion: the slot's z-10 absolute box would swallow clicks
            on the Right utility panel toggle in `#pawwork-titlebar-right`.
            Fixed here with `pointer-events-none` on the slot; the portalled
            tab buttons opt back in via `pointer-events-auto` on
            `<Tabs.List>` (see session-side-panel.tsx).
          - Visual occlusion: the base `[data-component="tabs"]` rule applies
            `background-color: var(--bg-base)` to the host. The sidepanel
            variant resets that to transparent in tabs.css so the slot does
            not paint over the toggle button beneath it. */}
      <div
        id="pawwork-titlebar-tabs"
        data-shell-slot="tabs-portal"
        data-component="tabs"
        data-variant="sidepanel"
        data-orientation="horizontal"
        data-scope="right-panel"
        class="absolute top-0 bottom-0 right-0 z-10 flex flex-row items-center border-l border-border-weaker pointer-events-none"
        style={{ width: "var(--right-panel-width, 0px)" }}
      />
    </header>
  )
}
