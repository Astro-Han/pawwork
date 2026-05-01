import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { basename, sourceKey, type BoundSession, type WorktreeInfo } from "./settings-worktrees-helpers"

export function SettingsWorktreeRow(props: {
  worktree: WorktreeInfo
  ownerName: string
  boundSession?: BoundSession
  confirming: boolean
  deleting: boolean
  onCancelDelete: () => void
  onConfirmDelete: (directory: string) => void
  onRequestDelete: (directory: string) => void
  onOpenSession: (entry: BoundSession) => void
}) {
  const language = useLanguage()
  const directory = () => props.worktree.directory
  const name = () => props.worktree.name || basename(props.worktree.directory)
  const branch = () => props.worktree.branch || ""
  const identity = () => branch() || name()
  const rowTooltip = () => [language.t(sourceKey(props.worktree.source)), directory()].filter(Boolean).join(" · ")

  return (
    <li
      class="flex items-center gap-3 min-h-[56px] py-2.5 px-2 -mx-2 rounded-md border-b border-border-weak-base last:border-none transition-colors"
      classList={{
        "bg-surface-warning-weak": props.confirming,
      }}
    >
      <Show
        when={!props.confirming}
        fallback={
          <>
            <Icon name="worktree" size="normal" class="shrink-0 text-text-base" />
            <div class="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span class="truncate text-13-medium text-text-strong">
                {language.t("settings.worktrees.confirmDelete.question", { name: name() })}
              </span>
              <span class="truncate text-12-regular text-text-weak" title={directory()}>
                {language.t("settings.worktrees.confirmDelete.warning")}
              </span>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="small" disabled={props.deleting} onClick={props.onCancelDelete}>
                {language.t("settings.worktrees.confirmDelete.cancelLabel")}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={props.deleting}
                onClick={() => props.onConfirmDelete(directory())}
              >
                {language.t("settings.worktrees.confirmDelete.confirmLabel")}
              </Button>
            </div>
          </>
        }
      >
        <Icon name="worktree" size="normal" class="shrink-0 text-text-weak" />
        <div class="flex min-w-0 flex-1 flex-col gap-[2px]" title={rowTooltip()}>
          <span class="truncate text-12-regular text-text-weak">{props.ownerName}</span>
          <span class="truncate text-13-medium text-text-strong">{identity()}</span>
        </div>
        <div class="flex shrink-0 items-center">
          <Show
            when={props.boundSession}
            fallback={
              <Button
                variant="ghost"
                size="small"
                disabled={props.deleting}
                onClick={() => props.onRequestDelete(directory())}
              >
                {language.t("settings.worktrees.delete")}
              </Button>
            }
          >
            {(entry) => (
              <Button
                variant="ghost"
                size="small"
                icon="bubble-5"
                onClick={() => props.onOpenSession(entry())}
                title={language.t("settings.worktrees.inUse", {
                  session: entry().title,
                })}
              >
                <span class="truncate max-w-[260px]">{entry().title}</span>
              </Button>
            )}
          </Show>
        </div>
      </Show>
    </li>
  )
}
