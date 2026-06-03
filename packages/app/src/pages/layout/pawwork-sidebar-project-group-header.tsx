import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"

export function ProjectGroupHeader(props: {
  projectKey: string
  label: string
  collapsed: boolean
  onToggle: () => void
  onRename: () => void
  onRemove: () => void
}) {
  const language = useLanguage()
  const projectMenuLabels = () => ({
    rename: language.t("project.rename"),
    remove: language.t("project.remove"),
  })

  return (
    <ContextMenu>
      <ContextMenu.Trigger as="div">
        <div
          data-component="pawwork-group-header"
          data-collapsed={props.collapsed ? "true" : undefined}
          title={props.projectKey}
          class="group/group-header h-[30px] w-full flex items-center rounded-sm text-body text-fg-weak transition-colors hover:bg-row-hover-overlay focus-within:bg-row-hover-overlay"
        >
          <button
            type="button"
            data-action="pawwork-group-toggle"
            data-collapsed={props.collapsed ? "true" : undefined}
            aria-expanded={!props.collapsed}
            onClick={props.onToggle}
            class="min-w-0 h-full flex-1 flex items-center gap-3 px-2.5 text-left focus:outline-none"
          >
            <Icon name={props.collapsed ? "folder" : "folder-open"} class="shrink-0 text-icon-weak" />
            <span class="min-w-0 flex-1 truncate">{props.label}</span>
          </button>
          <div class="pointer-events-none relative shrink-0 flex items-center justify-end h-[20px] min-w-[30px] pr-1">
            <div class="absolute inset-y-0 right-1 flex items-center justify-end opacity-0 pointer-events-none group-hover/group-header:opacity-100 group-hover/group-header:pointer-events-auto group-focus-within/group-header:opacity-100 group-focus-within/group-header:pointer-events-auto group-has-[[data-expanded]]/group-header:opacity-100 group-has-[[data-expanded]]/group-header:pointer-events-auto">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="dot-grid"
                  variant="ghost"
                  class="pointer-events-auto h-[26px] w-[26px]"
                  data-action="project-row-menu"
                  aria-label={language.t("common.moreOptions")}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item onSelect={props.onRename}>
                      <Icon name="edit" class="text-icon-weak" />
                      <DropdownMenu.ItemLabel>{projectMenuLabels().rename}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={props.onRemove}>
                      <Icon name="archive" class="text-icon-weak" />
                      <DropdownMenu.ItemLabel>{projectMenuLabels().remove}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={props.onRename}>
            <Icon name="edit" class="text-icon-weak" />
            <ContextMenu.ItemLabel>{projectMenuLabels().rename}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={props.onRemove}>
            <Icon name="archive" class="text-icon-weak" />
            <ContextMenu.ItemLabel>{projectMenuLabels().remove}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
  )
}
