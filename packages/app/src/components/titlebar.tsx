import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
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
  // Must match `SessionSidePanel`'s own desktop gate — that component only
  // mounts the panel (and portals tab content into the titlebar) at ≥768px.
  // Without this same predicate, opening the panel at desktop width and then
  // resizing below the breakpoint would leave the titlebar reserving
  // panel-width of empty rail (no portal to fill it), pushing the right
  // utility toggle off the viewport. Single source of truth for "is the
  // right panel actually visible right now": route + state + viewport.
  const isDesktop = createMediaQuery("(min-width: 768px)")
  // Tabs rail is only meaningful on session routes — `--right-panel-width`
  // is a global CSS var that survives navigation, so without this gate the
  // tabs slot would still claim panel-width on home/settings (where
  // SessionSidePanel doesn't render any tabs), pushing the right utility
  // toggle's StatusPopover fallback to the left.
  const tabsRailActive = createMemo(
    () => isDesktop() && location.pathname.includes("/session") && layout.rightPanel.opened(),
  )
  const tabsRailWidth = () => (tabsRailActive() ? "var(--right-panel-width, 0px)" : "0px")
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

      {/* Right titlebar rail. Two in-flow flex siblings, ordered left→right:
          (1) `#pawwork-titlebar-right` — the right utility toggle (or
              StatusPopover fallback on non-session routes), portalled in
              by SessionHeader.
          (2) `#pawwork-titlebar-tabs` — the right-panel tab strip, portalled
              in by SessionSidePanel only when the panel is open.

          The tabs slot's width follows `var(--right-panel-width)` so it
          occupies the same x-range as the right-panel body directly below
          and the `border-l` reads as one continuous separator from titlebar
          top to viewport bottom. Because the two slots are flex siblings
          (not an absolute overlay over the toggle), the toggle is naturally
          pushed left by `--right-panel-width` when the panel opens and
          slides back to the viewport edge when it closes. The 240ms
          transition on `--right-panel-width` carries the toggle smoothly
          along with the panel edge, and no pointer-events choreography is
          needed — the toggle and the tab strip own disjoint geometry.

          "Borrowed identity": the tabs slot stamps `data-component="tabs"`
          + `data-variant="sidepanel"` + `data-scope` + `data-orientation`
          so the descendant selectors in `packages/ui/src/components/tabs.css`
          (e.g. `[data-component="tabs"] [data-slot="tabs-list"]`) match the
          portalled `Tabs.List`. The base `[data-component="tabs"]` rule
          also sets `flex-direction: column` on the host (expecting
          Tabs.List + Tabs.Content stacked vertically); the slot's own
          `flex-row` class flips that locally so it stays a horizontal
          strip.

          `border-l` and the panel-width track only when `tabsRailActive`
          (session route + right panel open). On home/settings the slot
          shrinks to 0 width — without this gate, navigating away while
          the panel was left open would still claim panel-width in the
          titlebar (the CSS var survives navigation) and push the
          StatusPopover fallback to the left.

          `pr-2` lives on `#pawwork-titlebar-right` (not the outer rail)
          so it reads as "toggle inset from viewport edge" when the panel
          is closed and "gap between toggle and tabs border-l" when open.
          Putting it on the outer rail would shift the tabs slot 8px
          inboard of the viewport, misaligning its `border-l` with the
          right-panel body's `border-l` directly below it.

          `self-stretch` on the rail is load-bearing — the titlebar root
          uses `items-center`, which lets each grid cell collapse to its
          child's content height. Without this opt-out, the tabs slot's
          `self-stretch` would only reach the rail's content height
          (≈30px toggle row), and its `border-l` would break above and
          below the toggle row instead of meeting the right-panel body's
          `border-l` as one continuous separator. */}
      <div class="self-stretch flex items-center min-w-0 justify-end">
        <div
          id="pawwork-titlebar-right"
          data-shell-slot="right-portal"
          class="flex items-center gap-1 shrink-0 justify-end"
          classList={{ "pr-2": !windows() }}
        />
        <div
          id="pawwork-titlebar-tabs"
          data-shell-slot="tabs-portal"
          data-component="tabs"
          data-variant="sidepanel"
          data-orientation="horizontal"
          data-scope="right-panel"
          class="self-stretch flex flex-row items-center shrink-0"
          classList={{ "border-l border-border-weaker": tabsRailActive() }}
          style={{ width: tabsRailWidth() }}
        />
      </div>
    </header>
  )
}
