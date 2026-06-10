import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"

import { useLayout } from "@/context/layout"
import { isDesktopShell, isMacShell, isWindowsShell, shellAttrs, usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { applyPath, backPath, forwardPath, type TitlebarEntry } from "./titlebar-history"

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
    stack: [] as TitlebarEntry[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    // Track state as well as path: replaying an entry without its navigation
    // state would break the surface routes' close-to-origin contract.
    const current = { to: path(), state: location.state }

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
    // unwrap: a store-proxied state would fail the web router's pushState
    // structured clone (proxies are not cloneable).
    const entry = unwrap(next.entry)
    navigate(entry.to, { state: entry.state })
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    const entry = unwrap(next.entry)
    navigate(entry.to, { state: entry.state })
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

      {/* Right titlebar rail. Two children, intentionally NOT flex siblings:

          (1) `#pawwork-titlebar-tabs` — the right-panel tab strip, portalled
              in by SessionSidePanel only when the panel is open. In-flow,
              the only flex child of the rail; with `justify-end` on the
              rail it pins to the viewport right edge. Its width follows
              `var(--right-panel-width)` so the `border-l` lands at the
              same x as the right-panel body's `border-left` directly
              below, forming one continuous separator from titlebar top to
              viewport bottom.

          (2) `#pawwork-titlebar-right` — the right utility toggle (or
              StatusPopover fallback on non-session routes), portalled in
              by SessionHeader. **Absolute-positioned** to the rail's
              top-right corner (`right-2`) so it stays at the same visual
              x-coordinate (`viewport.right - 8px`) regardless of whether
              the panel is open or closed. PR #880 had this as an in-flow
              flex sibling that got pushed left by `--right-panel-width`
              when the panel opened; the resulting 240ms slide read as
              visually jarring once the alignment seam was fixed and the
              motion became visible against the now-aligned border-l. The
              absolute position trades a 240ms slide for a stable corner.

              The toggle visually overlaps the rightmost area of the tabs
              slot when open. The slot explicitly reserves a 44px
              padding-end (toggle width + viewport inset + gap + buffer;
              see the math in the inline style on the slot below) so the
              trailing `+` button cannot enter the toggle's hit-target
              zone — even if a future change makes Kobalte's Tabs.List
              fill the slot 100% (today it renders at content width as a
              CSS side-effect; the reserve makes the no-collision contract
              independent of that side-effect).

          "Borrowed identity": the tabs slot stamps `data-component="tabs"`
          + `data-variant="sidepanel"` + `data-scope` + `data-orientation`
          so the descendant selectors in `packages/ui/src/components/tabs.css`
          (e.g. `[data-component="tabs"] [data-slot="tabs-list"]`) match the
          portalled `Tabs.List`. The base `[data-component="tabs"]` rule
          also sets `flex-direction: column` on the host; the slot's own
          `flex-row` class flips that locally so it stays a horizontal
          strip.

          `border-l` and the panel-width track only when `tabsRailActive`
          (desktop + session route + right panel open). On home/settings
          the slot shrinks to 0 width — without this gate, navigating away
          while the panel was left open would still claim panel-width in
          the titlebar (the CSS var survives navigation) and the empty
          slot would still paint a border-l.

          `pr-2` on `#pawwork-titlebar-right` is gone — the absolute
          `right-2` positioning replaces it. `right-2` is `--space-2`
          (8px) by default per the design tokens, matching the old `pr-2`
          inset from the viewport edge.

          `self-stretch` on the rail is load-bearing — the titlebar root
          uses `items-center`, which lets each grid cell collapse to its
          child's content height. Without this opt-out, the tabs slot's
          `self-stretch` would only reach the rail's content height
          (≈0px when the absolute toggle takes the rail out of intrinsic
          sizing), and its `border-l` would not paint full-height. */}
      <div class="self-stretch relative flex items-center min-w-0 justify-end">
        <div
          id="pawwork-titlebar-tabs"
          data-shell-slot="tabs-portal"
          data-component="tabs"
          data-variant="sidepanel"
          data-orientation="horizontal"
          data-scope="right-panel"
          class="self-stretch flex flex-row items-center shrink-0"
          classList={{ "border-l border-border-weaker": tabsRailActive() }}
          style={{
            width: tabsRailWidth(),
            // Reserve the rightmost area of the slot for the absolute-
            // positioned toggle above it. Today Kobalte's Tabs.List renders
            // at content-width (~150px for 1-4 chips), so the `+` button
            // never reaches the slot's right edge and doesn't collide with
            // the toggle's hit-target. That's a coincidence of the current
            // CSS — if a future change makes Tabs.List fill 100% (a `w-full`
            // on the consumer, a tabs.css refactor, a Kobalte upgrade), the
            // `+` would slide under the toggle and intercept clicks meant
            // for it. The explicit padding-end makes the right-edge zone
            // part of the slot's layout contract, not a CSS coincidence.
            //
            // Math (44px): toggle button width 30 + `right-2` viewport
            // inset 8 + minimum visual gap 4 + 2px buffer for the Tabs.List
            // `px-1` content padding. Physical `padding-right` matches the
            // physical `right-2`/`right-0` on the toggle — they must stay
            // in the same writing-mode axis (both physical, or both
            // logical) or RTL flips one but not the other.
            //
            // Only applied when the rail is active; an empty slot
            // (panel closed, non-session route) needs no reserve.
            "padding-right": tabsRailActive() ? "44px" : undefined,
          }}
        />
        <div
          id="pawwork-titlebar-right"
          data-shell-slot="right-portal"
          class="absolute top-1/2 -translate-y-1/2 z-10 flex items-center gap-1 justify-end"
          classList={{ "right-2": !windows(), "right-0": windows() }}
        />
      </div>
    </header>
  )
}
