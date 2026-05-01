import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLayoutPage } from "@/context/layout-page"
import { useSessionLayout } from "@/pages/session/session-layout"
import { findWorkspaceProject, workspaceChipChoices } from "./workspace-chip-helpers"
import { workspaceKey } from "@/pages/layout/helpers"
import { decode64 } from "@/utils/base64"

export function WorkspaceChip(props: { style?: JSX.CSSProperties | string } = {}) {
  const language = useLanguage()
  const layout = useLayout()
  const layoutPage = useLayoutPage()
  const navigate = useNavigate()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)

  const current = createMemo(() => decode64(params.dir))
  const project = createMemo(() => findWorkspaceProject(layout.projects.list(), current()))
  const workspaces = createMemo(() => {
    return workspaceChipChoices({
      directory: current(),
      projects: layout.projects.list(),
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
      placement="bottom-start"
      triggerAs={"button"}
      triggerProps={
        {
          type: "button",
          "data-action": "prompt-workspace",
          "aria-label": language.t("workspace.chip.ariaLabel"),
          "aria-haspopup": "menu",
          class:
            "h-[28px] px-1.5 inline-flex items-center gap-1.5 rounded-xl text-13-regular text-text-base transition-colors hover:bg-surface-base-hover",
          style: props.style,
        } as any
      }
      trigger={
        <>
          <Icon name="folder" size="small" class="shrink-0 text-text-weak" />
          <span class="max-w-[120px] truncate transition-[max-width] duration-200 ease-out @max-[24rem]/composer:max-w-0">{label()}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
        </>
      }
      class="min-w-56 max-w-xs bg-surface-raised-stronger-non-alpha"
    >
      <div role="menu" aria-label={language.t("workspace.chip.popover.title")}>
        <div class="px-2 pt-0.5 pb-2 text-13-regular text-text-weak">
          {language.t("workspace.chip.popover.title")}
        </div>
        <Show
          when={workspaces().length > 0}
          fallback={<div class="px-2 py-2 text-13-regular text-text-weak">{language.t("workspace.chip.empty")}</div>}
        >
          <For each={workspaces()}>
            {(workspace) => {
              const active = createMemo(() => {
                const c = current()
                return c ? workspaceKey(workspace.path) === workspaceKey(c) : false
              })
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active()}
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13-regular outline-none hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover"
                  onClick={() => {
                    navigate(`/${base64Encode(workspace.path)}/session`)
                    setOpen(false)
                  }}
                >
                  <Icon name="folder" size="small" class="shrink-0 text-text-weak" />
                  <span class="min-w-0 flex-1 truncate text-text-strong">
                    {getFilename(workspace.path)}
                  </span>
                  <Show when={active()}>
                    <Icon name="check" size="small" class="shrink-0 text-text-strong" data-icon="check" />
                  </Show>
                </button>
              )
            }}
          </For>
        </Show>
        <div class="mt-1 border-t border-border-weaker-base pt-1">
          <button
            type="button"
            role="menuitem"
            data-action="workspace-chip-add"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-13-regular text-text-base outline-none hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover"
            onClick={() => {
              setOpen(false)
              layoutPage.openProject()
            }}
          >
            <Icon name="folder-add-left" size="small" class="shrink-0 text-text-weak" />
            <span class="min-w-0 flex-1 truncate">{language.t("workspace.chip.add")}</span>
          </button>
        </div>
      </div>
    </Popover>
  )
}
