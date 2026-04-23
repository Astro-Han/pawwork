import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLayoutPage } from "@/context/layout-page"
import { useSessionLayout } from "@/pages/session/session-layout"
import { findWorkspaceProject, workspaceChipChoices } from "./workspace-chip-helpers"
import { decode64 } from "@/utils/base64"

export function WorkspaceChip() {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const layout = useLayout()
  const layoutPage = useLayoutPage()
  const navigate = useNavigate()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)

  const current = createMemo(() => decode64(params.dir))
  const project = createMemo(() => findWorkspaceProject(layout.projects.list(), current()))
  const root = createMemo(() => project()?.worktree ?? current())
  const [listed] = createResource(
    () => (open() ? root() : undefined),
    async (directory) => {
      if (!directory) return []
      return globalSDK.client.worktree
        .list({ directory })
        .then((x) => x.data ?? [])
        .catch(() => [] as string[])
    },
  )
  const workspaces = createMemo(() => {
    return workspaceChipChoices({
      directory: current(),
      projects: layout.projects.list(),
      listed: listed(),
    })
  })
  const label = createMemo(() => {
    const directory = current()
    if (!directory) return language.t("workspace.chip.empty")
    return getFilename(directory)
  })

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      triggerAs={"button"}
      triggerProps={{
        type: "button",
        "aria-label": language.t("workspace.chip.ariaLabel"),
        "aria-haspopup": "listbox",
        class:
          "h-[26px] px-[9px] inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-transparent text-12 text-text-base hover:bg-background-base-hover",
      }}
      trigger={
        <>
          <Icon name="workspace" size="small" class="text-text-weak" />
          <span class="leading-none">{label()}</span>
          <Icon name="chevron-down" size="small" class="text-text-weak" />
        </>
      }
      class="w-60 rounded-[10px] border border-border-strong bg-surface-base p-1 shadow-lg"
    >
      <div role="listbox" aria-label={language.t("workspace.chip.popover.title")}>
        <div class="px-2.5 pt-1.5 pb-1 text-11 font-medium text-text-weak">
          {language.t("workspace.chip.popover.title")}
        </div>
        <Show
          when={workspaces().length > 0}
          fallback={<div class="px-2 py-2 text-12 text-text-weak">{language.t("workspace.chip.empty")}</div>}
        >
          <For each={workspaces()}>
            {(workspace) => {
              const active = createMemo(() => workspace === current())
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active()}
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12 outline-none hover:bg-background-base-hover focus-visible:bg-background-base-hover"
                  classList={{ "font-medium": active() }}
                  onClick={() => {
                    navigate(`/${base64Encode(workspace)}/session`)
                    setOpen(false)
                  }}
                >
                  <Icon name="workspace" size="small" class="text-text-weak" />
                  <span class="min-w-0 flex-1 truncate">{getFilename(workspace)}</span>
                </button>
              )
            }}
          </For>
        </Show>
        <div class="mt-1 border-t border-border-weaker-base pt-1">
          <button
            type="button"
            data-action="workspace-chip-add"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12 text-text-base outline-none hover:bg-background-base-hover focus-visible:bg-background-base-hover"
            onClick={() => {
              setOpen(false)
              layoutPage.openProject()
            }}
          >
            <Icon name="plus-small" size="small" class="text-text-weak" />
            <span class="min-w-0 flex-1 truncate">{language.t("workspace.chip.add")}</span>
          </button>
        </div>
      </div>
    </Popover>
  )
}

