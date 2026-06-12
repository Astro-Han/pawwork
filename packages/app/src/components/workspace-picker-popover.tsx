import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { getFilename } from "@opencode-ai/util/path"
import { createMemo, createSignal, For, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { workspaceKey } from "@/pages/layout/helpers"
import { workspaceChipChoices, type WorkspaceProject } from "./prompt-input/workspace-chip-helpers"

export type WorkspacePickerMenuProps = {
  current: Accessor<string | undefined>
  directStartDirectory: Accessor<string | undefined>
  projects: Accessor<WorkspaceProject[]>
  onSelect: (path: string) => void
  onAdd: () => void
}

export function WorkspacePickerMenu(props: WorkspacePickerMenuProps) {
  const language = useLanguage()
  const workspaces = createMemo(() => {
    return workspaceChipChoices({
      directory: props.current(),
      directStartDirectory: props.directStartDirectory(),
      projects: props.projects(),
    })
  })

  return (
    <div role="menu" aria-label={language.t("workspace.chip.popover.title")}>
      <div class="px-2 pt-0.5 pb-2 text-body text-fg-weak">{language.t("workspace.chip.popover.title")}</div>
      {workspaces().length > 0 ? (
        <div class="flex flex-col gap-0.5">
          <For each={workspaces()}>
            {(workspace) => {
              const active = createMemo(() => {
                const current = props.current()
                if (workspace.kind === "direct-start" && !current) return true
                return current ? workspaceKey(workspace.path) === workspaceKey(current) : false
              })
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active()}
                  data-picker-item=""
                  data-selected={active() ? "true" : undefined}
                  class="flex w-full items-center text-left outline-none"
                  onClick={() => props.onSelect(workspace.path)}
                >
                  <Icon
                    name={workspace.kind === "direct-start" ? "bubble-5" : "folder"}
                    class="shrink-0 text-fg-weak"
                  />
                  <span class="min-w-0 flex-1 truncate">
                    {workspace.kind === "direct-start"
                      ? language.t("workspace.chip.directStart")
                      : getFilename(workspace.path)}
                  </span>
                </button>
              )
            }}
          </For>
        </div>
      ) : (
        <div class="px-2 py-2 text-body text-fg-weak">{language.t("workspace.chip.empty")}</div>
      )}
      <div class="mt-1 border-t border-border-weaker pt-1">
        <button
          type="button"
          role="menuitem"
          data-action="workspace-chip-add"
          data-picker-item=""
          class="flex w-full items-center text-left outline-none"
          onClick={() => props.onAdd()}
        >
          <Icon name="folder-add-left" class="shrink-0 text-fg-weak" />
          <span class="min-w-0 flex-1 truncate">{language.t("workspace.chip.add")}</span>
        </button>
      </div>
    </div>
  )
}

export function WorkspacePickerPopover(
  props: WorkspacePickerMenuProps & {
    trigger: JSX.Element
    triggerProps: Record<string, unknown>
    class?: string
    placement?: "bottom-start" | "bottom-end"
  },
) {
  const [open, setOpen] = createSignal(false)

  return (
    <Popover
      open={open()}
      onOpenChange={setOpen}
      placement={props.placement ?? "bottom-start"}
      triggerAs="button"
      triggerProps={props.triggerProps as any}
      trigger={props.trigger}
      class={props.class}
    >
      <WorkspacePickerMenu
        current={props.current}
        directStartDirectory={props.directStartDirectory}
        projects={props.projects}
        onSelect={(path) => {
          props.onSelect(path)
          setOpen(false)
        }}
        onAdd={() => {
          setOpen(false)
          props.onAdd()
        }}
      />
    </Popover>
  )
}
