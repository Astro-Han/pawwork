import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import type { PawworkSortMode } from "./pawwork-session-nav"

export function PawworkSidebarAllHeader(props: {
  sortMode: Accessor<PawworkSortMode>
  onSetSortMode: (mode: PawworkSortMode) => void
  workspacePicker?: () => JSX.Element
}) {
  const language = useLanguage()
  return (
    <div class="mt-4 h-[30px] flex items-center justify-between px-2.5">
      <span class="text-body text-fg-weak">{language.t("sidebar.pawwork.all")}</span>
      <div class="flex min-w-0 items-center gap-1">
        {props.workspacePicker?.()}
        <DropdownMenu>
          <Tooltip placement="bottom" value={language.t("sidebar.pawwork.sort.label")}>
            <DropdownMenu.Trigger
              as={IconButton}
              data-action="pawwork-sort-trigger"
              data-mode={props.sortMode()}
              icon="sort"
              class="h-[26px] w-[26px]"
              aria-label={language.t("sidebar.pawwork.sort.label")}
            />
          </Tooltip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item
                data-action="pawwork-sort-option"
                data-value="time"
                onSelect={() => props.onSetSortMode("time")}
              >
                <Icon name="schedule" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>{language.t("sidebar.pawwork.sort.optionByTime")}</DropdownMenu.ItemLabel>
                <Show when={props.sortMode() === "time"}>
                  <Icon name="check" class="ml-auto text-icon-weak" />
                </Show>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                data-action="pawwork-sort-option"
                data-value="project"
                onSelect={() => props.onSetSortMode("project")}
              >
                <Icon name="folder" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>{language.t("sidebar.pawwork.sort.optionByProject")}</DropdownMenu.ItemLabel>
                <Show when={props.sortMode() === "project"}>
                  <Icon name="check" class="ml-auto text-icon-weak" />
                </Show>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
    </div>
  )
}
