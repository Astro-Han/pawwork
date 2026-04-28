import { createEffect, createMemo, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
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

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

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
          <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <Show when={!mac()}>
          <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
            <IconButton
              icon="menu"
              variant="ghost"
              class="titlebar-icon rounded-md"
              onClick={layout.mobileSidebar.toggle}
              aria-label={language.t("sidebar.menu.toggle")}
              aria-expanded={layout.mobileSidebar.opened()}
            />
          </div>
        </Show>
        <div class="flex items-center gap-1 shrink-0">
          <TooltipKeybind
            class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
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
          <div class="hidden xl:flex items-center shrink-0">
            <Show when={params.dir}>
              <div
                class="flex items-center shrink-0 w-8"
                aria-hidden={layout.sidebar.opened() ? "true" : undefined}
              >
                <div
                  class="transition-opacity"
                  classList={{
                    "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                    "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                  }}
                >
                  <TooltipKeybind
                    placement="bottom"
                    title={language.t("command.session.new")}
                    keybind={command.keybind("session.new")}
                    openDelay={2000}
                  >
                    <Button
                      variant="ghost"
                      icon={creating() ? "new-session-active" : "new-session"}
                      class="titlebar-icon w-8 h-6 p-0 box-border"
                      disabled={layout.sidebar.opened()}
                      tabIndex={layout.sidebar.opened() ? -1 : undefined}
                      onClick={() => {
                        if (!params.dir) return
                        navigate(`/${params.dir}/session`)
                      }}
                      aria-label={language.t("command.session.new")}
                      aria-current={creating() ? "page" : undefined}
                    />
                  </TooltipKeybind>
                </div>
              </div>
            </Show>
          </div>
        </div>
        <div id="opencode-titlebar-left" data-shell-slot="left-portal" class="flex items-center gap-3 min-w-0 px-2" />
      </div>

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
