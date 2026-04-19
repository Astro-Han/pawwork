import { Popover } from "@opencode-ai/ui/popover"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSessionLayout } from "@/pages/session/session-layout"
import { decode64 } from "@/utils/base64"

export function WorkspaceChip() {
  const language = useLanguage()
  const layout = useLayout()
  const navigate = useNavigate()
  const { params } = useSessionLayout()
  const [open, setOpen] = createSignal(false)

  const current = createMemo(() => decode64(params.dir))
  const project = createMemo(() => {
    const directory = current()
    if (!directory) return
    return layout.projects.list().find((item) => item.worktree === directory || item.sandboxes?.includes(directory))
  })
  const workspaces = createMemo(() => {
    const directory = current()
    const item = project()
    if (!item) return directory ? [directory] : []

    const list = [item.worktree, ...(item.sandboxes ?? [])]
    if (directory && !list.includes(directory)) list.push(directory)
    return list
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
          <FolderIcon class="text-text-weak" />
          <span class="leading-none">{label()}</span>
          <ChevronIcon class="text-text-weak" />
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
                  class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-12 hover:bg-background-base-hover"
                  classList={{ "font-medium": active() }}
                  onClick={() => {
                    navigate(`/${base64Encode(workspace)}/session`)
                    setOpen(false)
                  }}
                >
                  <FolderIcon class="text-text-weak" />
                  <span class="min-w-0 flex-1 truncate">{getFilename(workspace)}</span>
                </button>
              )
            }}
          </For>
        </Show>
      </div>
    </Popover>
  )
}

function FolderIcon(props: { class?: string }) {
  return (
    <div data-component="icon" data-size="small" class={props.class}>
      <svg data-slot="icon-svg" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V3.5z"
          stroke="currentColor"
          stroke-width="1.1"
        />
      </svg>
    </div>
  )
}

function ChevronIcon(props: { class?: string }) {
  return (
    <div data-component="icon" data-size="small" class={props.class}>
      <svg data-slot="icon-svg" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M3.5 5.5l3.5 3 3.5-3" stroke="currentColor" stroke-width="1.1" fill="none" />
      </svg>
    </div>
  )
}
