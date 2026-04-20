import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
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
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"
import { StatusPopover } from "../status-popover"

export function SessionHeader() {
  const layout = useLayout()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const shellSurface = useShellSurface()
  const sync = useSync()
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
  const sessionInfo = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const sessionTitle = createMemo(() => sessionInfo()?.title || params.id || "")
  const homeTitle = createMemo(() => language.t("command.session.new"))
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
      <Show when={!shellSurface.settingsOpen() && centerMount()}>
        {(mount) => (
          <Portal mount={mount()}>
            <div class="hidden md:flex min-w-0 items-center gap-1.5 text-13-medium">
              <Show
                when={params.id}
                fallback={<div class="min-w-0 truncate text-text-strong">{homeTitle()}</div>}
              >
                <Show when={projectDirectory()}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    class="max-w-[180px] min-w-0 items-center gap-1 rounded-md px-1.5 shadow-none text-text-weak hover:text-text-strong"
                    onClick={openProjectDirectory}
                    aria-label={
                      canOpenProjectDirectory() ? language.t("session.header.open.ariaLabel", { app: fileManagerLabel() }) : undefined
                    }
                    title={projectDirectory()}
                    disabled={!canOpenProjectDirectory()}
                  >
                    <Icon name="folder" size="small" class="shrink-0 text-icon-weak" />
                    <span class="min-w-0 truncate">{name()}</span>
                  </Button>
                </Show>
                <Show when={projectDirectory()}>
                  <span class="shrink-0 text-text-weaker">/</span>
                </Show>
                <span class="min-w-0 truncate text-text-strong">{sessionTitle()}</span>
              </Show>
            </div>
          </Portal>
        )}
      </Show>
      <Show when={!shellSurface.settingsOpen() && rightMount()}>
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
                  <Icon
                    size="small"
                    name={rightPanelOpen() ? "sidebar-active" : "sidebar"}
                    class="-scale-x-100"
                  />
                </Button>
              </Tooltip>
            </Show>
          </Portal>
        )}
      </Show>
    </>
  )
}
