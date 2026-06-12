import { createSignal, For, Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { getFilename } from "@opencode-ai/util/path"
import { useLanguage } from "@/context/language"
import { workspaceKey } from "@/pages/layout/helpers"

export interface AutomationProject {
  id: string
  worktree: string
  name?: string
}

const projectLabel = (project: AutomationProject) => project.name || getFilename(project.worktree)

// Working-directory picker for the create card, mirroring the composer's
// WorkspaceChip (folder icon + name + popover of open projects). Unlike the
// chip it writes the card's local directory/projectID state instead of
// navigating the route, so the automation can be filed against any open project.
// The "row" variant restyles the trigger as a detail-sidebar value (no border,
// no folder icon) for the detail page's Project editor row.
export function AutomationFolderPicker(props: {
  projects: AutomationProject[]
  current: string
  onSelect: (project: AutomationProject) => void
  onOpenProject?: () => void
  variant?: "knob" | "row"
  action?: string
}): JSX.Element {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const isActive = (project: AutomationProject) => workspaceKey(project.worktree) === workspaceKey(props.current)
  const label = () => {
    const match = props.projects.find(isActive)
    return match ? projectLabel(match) : getFilename(props.current)
  }
  const row = () => props.variant === "row"

  return (
    <Popover
      modal
      open={open()}
      onOpenChange={setOpen}
      placement={row() ? "bottom-end" : "bottom-start"}
      class="min-w-56 max-w-xs"
      triggerAs="button"
      triggerProps={
        {
          type: "button",
          "data-action": props.action ?? "automation-folder",
          "data-picker-trigger": "",
          "aria-label": language.t("workspace.chip.ariaLabel"),
          "aria-haspopup": "menu",
          class: row()
            ? "inline-flex min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 text-right text-body text-fg-base hover:bg-row-hover-overlay hover:text-fg-strong focus-visible:bg-row-hover-overlay focus-visible:text-fg-strong focus:outline-none cursor-pointer"
            : "inline-flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border border-border-weak px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none cursor-pointer",
        } as never
      }
      trigger={[
        <Show when={!row()}>
          <Icon name="folder" class="shrink-0 text-icon-weak" />
        </Show>,
        <span class="min-w-0 truncate">{label()}</span>,
        <Icon name="chevron-down" class={row() ? "size-3 shrink-0 text-icon-weak" : "shrink-0 text-icon-weak"} />,
      ]}
    >
      <div role="menu" aria-label={language.t("workspace.chip.popover.title")}>
        <div class="px-2 pt-0.5 pb-2 text-body text-fg-weak">
          {language.t("workspace.chip.popover.title")}
        </div>
        <Show
          when={props.projects.length > 0}
          fallback={<div class="px-2 py-2 text-body text-fg-weak">{language.t("workspace.chip.empty")}</div>}
        >
          <div class="flex flex-col gap-0.5">
            <For each={props.projects}>
              {(project) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive(project)}
                  data-picker-item=""
                  data-project={project.id}
                  data-selected={isActive(project) ? "true" : undefined}
                  onClick={() => {
                    props.onSelect(project)
                    setOpen(false)
                  }}
                  class="flex w-full items-center text-left outline-none"
                >
                  <Icon name="folder" class="shrink-0 text-fg-weak" />
                  <span class="min-w-0 flex-1 truncate">{projectLabel(project)}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.onOpenProject}>
          <div class="mt-1 border-t border-border-weaker pt-1">
            <button
              type="button"
              role="menuitem"
              data-action="automation-folder-open-project"
              data-picker-item=""
              class="flex w-full items-center text-left outline-none"
              onClick={() => {
                setOpen(false)
                props.onOpenProject?.()
              }}
            >
              <Icon name="folder-add-left" class="shrink-0 text-fg-weak" />
              <span class="min-w-0 flex-1 truncate">{language.t("workspace.chip.add")}</span>
            </button>
          </div>
        </Show>
      </div>
    </Popover>
  )
}
