import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useLanguage } from "@/context/language"
import type { RightPanelTab } from "@/pages/session/right-panel-tabs"

export function ShellTab(props: {
  value: RightPanelTab
  label: string
  closable: boolean
  onClose: (tab: RightPanelTab) => void
  children: JSX.Element
}): JSX.Element {
  const language = useLanguage()
  const close = () => {
    if (!props.closable) return
    props.onClose(props.value)
  }

  return (
    <div class="h-full flex items-center">
      <Tabs.Trigger
        value={props.value}
        class="shrink-0 h-7"
        classes={{
          button:
            "h-7 min-h-7 inline-flex items-center whitespace-nowrap rounded-md text-13-medium text-text-weak gap-1.5 px-2.5",
        }}
        closeButton={
          props.closable ? (
            <Tooltip value={language.t("common.closeTab")} placement="bottom" gutter={10}>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={close}
                aria-label={language.t("common.closeTab")}
              />
            </Tooltip>
          ) : undefined
        }
        hideCloseButton
        onMiddleClick={close}
        aria-label={props.label}
      >
        {props.children}
      </Tabs.Trigger>
    </div>
  )
}

export function SortableShellTab(props: {
  value: RightPanelTab
  label: string
  closable: boolean
  onClose: (tab: RightPanelTab) => void
  children: JSX.Element
}): JSX.Element {
  const sortable = createSortable(props.value)

  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <ShellTab {...props} />
    </div>
  )
}
