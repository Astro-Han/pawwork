import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Show } from "solid-js"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection } from "@/context/server"
import { type ServerHealth } from "@/utils/server-health"

interface ServerConnectionListProps {
  items: () => ServerConnection.Any[]
  current: () => ServerConnection.Any | undefined
  status: Record<ServerConnection.Key, ServerHealth | undefined>
  defaultKey: () => ServerConnection.Key | null | undefined
  canDefault: () => boolean
  setDefault: (key: ServerConnection.Key | null) => void | Promise<void>
  onEdit: (conn: ServerConnection.Http) => void
  onRemove: (key: ServerConnection.Key) => void | Promise<void>
  onSelect: (conn: ServerConnection.Any) => void | Promise<void>
}

export function ServerConnectionList(props: ServerConnectionListProps) {
  const language = useLanguage()
  const currentKey = () => {
    const current = props.current()
    return current ? ServerConnection.key(current) : undefined
  }

  return (
    <List
      search={{
        placeholder: language.t("dialog.server.search.placeholder"),
        autofocus: false,
      }}
      noInitialSelection
      emptyMessage={language.t("dialog.server.empty")}
      items={props.items}
      key={ServerConnection.key}
      onSelect={(x) => {
        if (x) props.onSelect(x)
      }}
      divider={true}
      class="px-5 [&_[data-slot=list-search-wrapper]]:w-full [&_[data-slot=list-scroll]]:h-[300px] [&_[data-slot=list-scroll]]:overflow-y-auto [&_[data-slot=list-items]]:bg-surface-base [&_[data-slot=list-items]]:rounded-[var(--radius-md)] [&_[data-slot=list-item]]:min-h-14 [&_[data-slot=list-item]]:p-3 [&_[data-slot=list-item]]:!bg-transparent"
    >
      {(i) => {
        const key = ServerConnection.key(i)
        return (
          <div class="flex items-center gap-3 min-w-0 flex-1 w-full group/item">
            <div class="flex flex-col h-full items-start w-5">
              <ServerHealthIndicator health={props.status[key]} />
            </div>
            <ServerRow
              conn={i}
              dimmed={props.status[key]?.healthy === false}
              status={props.status[key]}
              class="flex items-center gap-3 min-w-0 flex-1"
              badge={
                <Show when={props.defaultKey() === ServerConnection.key(i)}>
                  <span class="text-fg-base bg-surface-base text-body px-1.5 rounded-sm">
                    {language.t("dialog.server.status.default")}
                  </span>
                </Show>
              }
              showCredentials
            />
            <div class="flex items-center justify-center gap-4 pl-4">
              <Show when={currentKey() === key}>
                <Icon name="check" class="h-6" />
              </Show>

              <Show when={i.type === "http"}>
                <DropdownMenu>
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="dot-grid"
                    variant="ghost"
                    class="shrink-0 size-8 hover:bg-row-active-overlay data-[expanded]:bg-surface-base-active"
                    onClick={(e: MouseEvent) => e.stopPropagation()}
                    onPointerDown={(e: PointerEvent) => e.stopPropagation()}
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content class="mt-1">
                      <DropdownMenu.Item
                        onSelect={() => {
                          if (i.type !== "http") return
                          props.onEdit(i)
                        }}
                      >
                        <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.edit")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <Show when={props.canDefault() && props.defaultKey() !== key}>
                        <DropdownMenu.Item onSelect={() => props.setDefault(key)}>
                          <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.default")}</DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </Show>
                      <Show when={props.canDefault() && props.defaultKey() === key}>
                        <DropdownMenu.Item onSelect={() => props.setDefault(null)}>
                          <DropdownMenu.ItemLabel>
                            {language.t("dialog.server.menu.defaultRemove")}
                          </DropdownMenu.ItemLabel>
                        </DropdownMenu.Item>
                      </Show>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        onSelect={() => props.onRemove(ServerConnection.key(i))}
                        class="text-error-text hover:bg-error-bg"
                      >
                        <DropdownMenu.ItemLabel>{language.t("dialog.server.menu.delete")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </Show>
            </div>
          </div>
        )
      }}
    </List>
  )
}
