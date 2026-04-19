import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { showToast } from "@opencode-ai/ui/toast"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/util/path"
import { createMediaQuery } from "@solid-primitives/media"
import { createMemo, Show } from "solid-js"
import { useLocation } from "@solidjs/router"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { StatusPopover } from "../status-popover"

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const location = useLocation()
  const { params, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))
  const onSessionRoute = createMemo(() => location.pathname.includes("/session"))
  const fileManagerLabel = createMemo(() => {
    if (platform.os === "windows") return language.t("session.header.open.fileExplorer")
    if (platform.os === "linux") return language.t("session.header.open.fileManager")
    return language.t("session.header.open.finder")
  })
  const canOpenProjectDirectory = createMemo(
    () => platform.platform === "desktop" && !!platform.openPath && server.isLocal() && !!projectDirectory(),
  )
  const rightPanelOpen = createMemo(() => view().sidePanel.opened())
  const toggleRightPanel = () => {
    if (rightPanelOpen()) {
      view().sidePanel.close()
      return
    }
    view().sidePanel.open()
  }
  const openProjectDirectory = () => {
    const directory = projectDirectory()
    if (!directory || !platform.openPath || !canOpenProjectDirectory()) return
    void platform.openPath(directory).catch((error) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const centerMount = createMemo(() => document.getElementById("opencode-titlebar-center"))
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))

  return (
    <>
      <Show when={centerMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="hidden md:flex min-w-0 items-center gap-2">
              <Show when={projectDirectory()}>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  class="max-w-[180px] min-w-0 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel px-2.5 shadow-none"
                  onClick={openProjectDirectory}
                  aria-label={
                    canOpenProjectDirectory() ? language.t("session.header.open.ariaLabel", { app: fileManagerLabel() }) : undefined
                  }
                  title={projectDirectory()}
                  disabled={!canOpenProjectDirectory()}
                >
                  <Icon name="folder" size="small" class="shrink-0 text-icon-weak" />
                  <span class="min-w-0 truncate text-12-regular text-text-strong">{name()}</span>
                </Button>
              </Show>
              <Button
                type="button"
                variant="ghost"
                size="small"
                class="w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
                onClick={() => command.trigger("file.open")}
                aria-label={language.t("session.header.searchFiles")}
              >
                <div class="flex min-w-0 flex-1 items-center overflow-visible">
                  <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                    {language.t("session.header.search.placeholder", {
                      project: name(),
                    })}
                  </span>
                </div>

                <Show when={hotkey()}>
                  {(keybind) => (
                    <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                      {keybind()}
                    </Keybind>
                  )}
                </Show>
              </Button>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <Show
              when={onSessionRoute() && isDesktop()}
              fallback={
                <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                  <StatusPopover />
                </Tooltip>
              }
            >
              <Tooltip placement="bottom" value={language.t("session.panel.utility")}>
                <Button
                  variant="ghost"
                  class="titlebar-icon w-8 h-6 p-0 box-border"
                  onClick={toggleRightPanel}
                  aria-label={language.t("session.panel.utility")}
                  aria-expanded={rightPanelOpen()}
                  aria-controls="right-panel"
                >
                  <div data-component="icon" data-size="small">
                    <svg data-slot="icon-svg" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <rect x="2" y="2.5" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1" />
                      <path d="M8.5 2.5v9" stroke="currentColor" stroke-width="1.1" />
                    </svg>
                  </div>
                </Button>
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
    </>
  )
}
