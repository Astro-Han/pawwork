import { For, Match, Show, Switch } from "solid-js"
import { Portal } from "solid-js/web"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { SortableProvider } from "@thisbeyond/solid-dnd"

import { SessionContextUsage } from "@/components/session-context-usage"
import { ShellTab, SortableShellTab } from "@/components/session"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { sortableShellTabIds } from "@/pages/session/helpers"
import type { RightPanelShellIconName, RightPanelTab, ShellTabIcon } from "@/pages/session/right-panel-tabs"

interface ShellTabDef {
  value: RightPanelTab
  label: string
  icon: ShellTabIcon
  closable: boolean
}

/** Maps right-panel tab names to their shell icon components. */
function RightPanelShellIcon(props: { icon: ShellTabIcon; active?: boolean }) {
  return (
    <Switch>
      <Match when={props.icon.kind === "indicator"}>
        <SessionContextUsage variant="indicator" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "status"}>
        <Icon name="status" class="text-fg-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "folder"}>
        <Icon name="folder" class="text-fg-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "review"}>
        <Icon name={props.active ? "review-active" : "review"} class="text-fg-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "terminal"}>
        <Icon name={props.active ? "terminal-active" : "terminal"} class="text-fg-weaker" />
      </Match>
    </Switch>
  )
}

/**
 * Portalled tab strip rendered into the titlebar chrome. Owns the sortable
 * shell-tab chips, the `+` dropdown for adding tabs, and the spacer that
 * pushes the add button to the right edge.
 */
export function RightPanelTabStrip(props: {
  tabsPortalMount: () => HTMLElement | undefined
  shellTabs: () => ShellTabDef[]
  activeTab: () => string | undefined
  openShellTabs: () => RightPanelTab[]
  closeTab: (tab: RightPanelTab) => void
  openTab: (tab: RightPanelTab) => void
  closableMissingTabs: () => {
    value: RightPanelTab
    label: string
    iconName: RightPanelShellIconName
    keybind?: string
  }[]
  openFilePicker: (onOpenFile?: () => void) => void
  showAllFiles: () => void
}) {
  const language = useLanguage()
  const command = useCommand()
  return (
    <Show when={props.tabsPortalMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          {/* Tabs.List portals into <Titlebar>'s `pawwork-titlebar-tabs` slot so the
              tabs visually sit on the window chrome and the panel's body border-left
              meets the titlebar separator with no gap. Portal keeps Tabs/Sortable/DnD
              contexts intact via the virtual tree. The slot owns the titlebar height
              (--shell-titlebar-height, 44px on desktop) and centers this list
              vertically; no border-b because the titlebar slot owns the bottom-edge
              alignment with the panel body below. */}
          <Tabs.List class="h-full shrink-0 px-1 py-0 items-center">
            <SortableProvider ids={sortableShellTabIds(props.openShellTabs())}>
              <For each={props.shellTabs()}>
                {(tab) => (
                  <Show
                    when={tab.value !== "status"}
                    fallback={
                      <ShellTab
                        value={tab.value}
                        label={tab.label}
                        closable={tab.closable}
                        onClose={props.closeTab}
                        icon={<RightPanelShellIcon icon={tab.icon} active={props.activeTab() === tab.value} />}
                      />
                    }
                  >
                    <SortableShellTab
                      value={tab.value}
                      label={tab.label}
                      closable={tab.closable}
                      onClose={props.closeTab}
                      icon={<RightPanelShellIcon icon={tab.icon} active={props.activeTab() === tab.value} />}
                    />
                  </Show>
                )}
              </For>
            </SortableProvider>
            {/* Spacer pushes the `+` button to the rail's right edge so
                the chip strip reads left-justified and `+` lives at the
                end of the rail (matching docs/design/ui_kits/desktop/RightPanel.jsx). */}
            <div class="flex-1" />
            <DropdownMenu gutter={4} placement="bottom-end">
              <DropdownMenu.Trigger
                as={IconButton}
                icon="plus-small"
                variant="ghost"
                class="shrink-0"
                aria-label={language.t("session.panel.addTab")}
              />
              <DropdownMenu.Portal>
                <DropdownMenu.Content>
                  <DropdownMenu.Item onSelect={() => props.openFilePicker(props.showAllFiles)}>
                    <Icon name="open-file" />
                    <DropdownMenu.ItemLabel>{language.t("command.file.open")}</DropdownMenu.ItemLabel>
                    <span class="ml-auto text-body text-fg-weaker">{command.keybind("file.open")}</span>
                  </DropdownMenu.Item>
                  <Show when={props.closableMissingTabs().length > 0}>
                    <DropdownMenu.Separator />
                    <For each={props.closableMissingTabs()}>
                      {(tab) => (
                        <DropdownMenu.Item onSelect={() => props.openTab(tab.value)}>
                          <Icon name={tab.iconName} />
                          <DropdownMenu.ItemLabel>{tab.label}</DropdownMenu.ItemLabel>
                          {tab.keybind && <span class="ml-auto text-body text-fg-weaker">{tab.keybind}</span>}
                        </DropdownMenu.Item>
                      )}
                    </For>
                  </Show>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu>
          </Tabs.List>
        </Portal>
      )}
    </Show>
  )
}
