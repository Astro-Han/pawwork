import { Icon } from "@opencode-ai/ui/icon"
import { base64Encode } from "@opencode-ai/util/encode"
import { useNavigate } from "@solidjs/router"
import { createMemo, type JSX } from "solid-js"
import { WorkspacePickerPopover } from "@/components/workspace-picker-popover"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLayoutPage } from "@/context/layout-page"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  workspaceChipIconName,
  workspaceChipLabel,
} from "./workspace-chip-helpers"
import { decode64 } from "@/utils/base64"

export function WorkspaceChip(props: { style?: JSX.CSSProperties | string } = {}) {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const layoutPage = useLayoutPage()
  const navigate = useNavigate()
  const { params } = useSessionLayout()

  const current = createMemo(() => decode64(params.dir))
  const directStartDirectory = createMemo(() => globalSync.data.path.directory)
  const label = createMemo(() => {
    return workspaceChipLabel({
      directory: current(),
      directStartDirectory: directStartDirectory(),
      directStartLabel: language.t("workspace.chip.directStart"),
      emptyLabel: language.t("workspace.chip.empty"),
      projects: layout.projects.list(),
    })
  })

  return (
    <WorkspacePickerPopover
      placement="bottom-start"
      triggerProps={
        {
          type: "button",
          "data-action": "prompt-workspace",
          "data-picker-trigger": "",
          "aria-label": language.t("workspace.chip.ariaLabel"),
          "aria-haspopup": "menu",
          class:
            "px-1.5 inline-flex items-center gap-1.5 text-body text-fg-base font-normal",
          style: props.style,
        } as any
      }
      trigger={
        <>
          <Icon
            name={workspaceChipIconName({
              directory: current(),
              directStartDirectory: directStartDirectory(),
              projects: layout.projects.list(),
            })}
            class="shrink-0 text-fg-weak"
          />
          <span class="max-w-[120px] truncate transition-[max-width] duration-200 ease-out @max-[24rem]/composer:max-w-0">{label()}</span>
          <Icon name="chevron-down" class="shrink-0 text-fg-weak" />
        </>
      }
      current={current}
      directStartDirectory={directStartDirectory}
      projects={() => layout.projects.list()}
      onSelect={(path) => navigate(`/${base64Encode(path)}/session`)}
      onAdd={layoutPage.openProject}
      class="min-w-56 max-w-xs"
    />
  )
}
