import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
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

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const web = createMemo(() => platform.platform === "web")
  const zoom = () => platform.webviewZoom?.() ?? 1
  const currentTitlebarHeight = () =>
    mac() ? "var(--shell-titlebar-current-height, var(--shell-titlebar-height, 40px))" : undefined
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
      data-os={platform.os}
      class="shrink-0 relative grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
      classList={{ "h-11": platform.platform === "desktop" && !mac() }}
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
            class={web() ? "flex shrink-0 ml-14" : "flex shrink-0 ml-2"}
            placement="bottom"
            title={language.t("command.sidebar.toggle")}
            keybind={command.keybind("sidebar.toggle")}
          >
            <Button
              variant="ghost"
              class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
              onClick={layout.sidebar.toggle}
              aria-label={language.t("command.sidebar.toggle")}
              aria-expanded={layout.sidebar.opened()}
            >
              <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
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
                class="titlebar-icon w-8 h-6 p-0 box-border"
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
        id="opencode-titlebar-left"
        data-shell-slot="left-portal"
        class="@container pointer-events-none absolute inset-y-0 z-10 flex min-w-0 items-center gap-3 overflow-hidden"
        style={leftPortalStyle()}
      />

      <div class="min-w-0 flex items-center justify-center pointer-events-none">
        <div id="opencode-titlebar-center" class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full" />
      </div>

      <div
        classList={{
          "flex items-center min-w-0 justify-end": true,
          "pr-2": !windows(),
        }}
      >
        <div
          id="opencode-titlebar-right"
          data-shell-slot="right-portal"
          class="flex items-center gap-1 shrink-0 justify-end"
        />
      </div>
    </header>
  )
}
