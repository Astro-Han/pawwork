import { For, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { getFilename } from "@opencode-ai/util/path"
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
export function AutomationFolderPicker(props: {
  projects: AutomationProject[]
  current: string
  onSelect: (project: AutomationProject) => void
}): JSX.Element {
  const isActive = (project: AutomationProject) => workspaceKey(project.worktree) === workspaceKey(props.current)
  const label = () => {
    const match = props.projects.find(isActive)
    return match ? projectLabel(match) : getFilename(props.current)
  }

  return (
    <Popover
      modal
      placement="bottom-start"
      class="min-w-56 max-w-xs"
      triggerAs="button"
      triggerProps={
        {
          type: "button",
          "data-action": "automation-folder",
          "data-picker-trigger": "",
          "aria-haspopup": "menu",
          class:
            "inline-flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border border-border-weak px-2.5 text-body text-fg-base hover:bg-row-hover-overlay focus:outline-none cursor-pointer",
        } as never
      }
      trigger={
        <>
          <Icon name="folder" class="shrink-0 text-icon-weak" />
          <span class="min-w-0 truncate">{label()}</span>
          <Icon name="chevron-down" class="shrink-0 text-icon-weak" />
        </>
      }
    >
      <div role="menu" class="flex flex-col gap-px">
        <For each={props.projects}>
          {(project) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={isActive(project)}
              data-picker-item=""
              data-project={project.id}
              data-selected={isActive(project) ? "" : undefined}
              onClick={() => props.onSelect(project)}
              class="flex w-full items-center text-left outline-none"
            >
              <Icon name="folder" class="shrink-0 text-icon-weak" />
              <span class="min-w-0 flex-1 truncate">{projectLabel(project)}</span>
            </button>
          )}
        </For>
      </div>
    </Popover>
  )
}
