import { createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { getDirectory } from "@opencode-ai/core/util/path"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"
import { normalize } from "./session-diff"
import type { TurnChangeDisplay, TurnChangeFile } from "./session-turn-changes"

/**
 * Slice 11b.1: turn-changes card extracted from `session-turn.tsx` per
 * design doc §2a.
 *
 * Renders the post-turn "files changed" summary with per-file rows.
 * Each row supports:
 *   - chevron-toggle to expand an inline diff (when `file.expandable`);
 *   - "open file" + "show in folder" icon actions wired to the
 *     timeline-level handlers passed via `actions`;
 *   - status badge (added / deleted / modified) when add/delete counts
 *     are unavailable;
 *   - unrestorable hint for large deletes.
 *
 * Header row carries the additions / deletions totals, optional
 * truncation hint, undone marker, and the undo/redo confirm button
 * resolved by the parent (handles double-click confirmation timing).
 */

export type TurnChangesListProps = {
  change: TurnChangeDisplay
  files: TurnChangeFile[]
  edited: number
  additions: number
  deletions: number
  isUndone: boolean
  expanded: string[]
  setExpanded: (next: string[] | ((current: string[]) => string[])) => void
  actionLabel: string
  confirmAction: "undo" | "redo" | undefined
  hasAction: boolean
  onAction: () => void
  onResetConfirm: () => void
  openFile?: (path: string) => void
  showInFolder?: (path: string) => void
  statusLabel: (status: TurnChangeFile["status"]) => string
}

export function TurnChangesList(props: TurnChangesListProps) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  return (
    <div data-slot="session-turn-changes" data-component="session-turn-changes">
      <div data-slot="session-turn-changes-header">
        <div data-slot="session-turn-changes-summary">
          <span>
            {i18n.t(
              props.edited === 1
                ? "ui.sessionTurn.turnChanges.summary.one"
                : "ui.sessionTurn.turnChanges.summary.other",
              { count: props.edited },
            )}
          </span>
          <span data-slot="session-turn-changes-additions">+{props.additions}</span>
          <span data-slot="session-turn-changes-deletions">-{props.deletions}</span>
          <Show when={props.change.truncated && (props.change.omittedCount ?? 0) > 0}>
            <span data-slot="session-turn-changes-omitted">
              {i18n.t("ui.sessionTurn.turnChanges.omitted", { count: props.change.omittedCount ?? 0 })}
            </span>
          </Show>
          <Show when={props.isUndone}>
            <span data-slot="session-turn-changes-undone">{i18n.t("ui.sessionTurn.turnChanges.undone")}</span>
          </Show>
        </div>
        <Show when={props.actionLabel && props.hasAction}>
          <button
            type="button"
            data-slot="session-turn-changes-action"
            data-confirm={props.confirmAction || undefined}
            onClick={props.onAction}
            onMouseLeave={props.onResetConfirm}
          >
            {props.actionLabel}
          </button>
        </Show>
      </div>
      <div data-slot="session-turn-changes-list">
        <For each={props.files}>
          {(file) => {
            const expanded = createMemo(() => props.expanded.includes(file.path))
            const toggle = () => {
              if (!file.expandable) return
              props.setExpanded((current) =>
                current.includes(file.path)
                  ? current.filter((item) => item !== file.path)
                  : [...current, file.path],
              )
            }
            const view = createMemo(() =>
              file.patch
                ? normalize({
                    file: file.path,
                    patch: file.patch,
                    additions: file.additions ?? 0,
                    deletions: file.deletions ?? 0,
                    status: file.status,
                  })
                : undefined,
            )
            return (
              <div data-slot="session-turn-change-item" data-expanded={expanded() || undefined}>
                <div
                  data-slot="session-turn-change-row"
                  data-expandable={file.expandable || undefined}
                  onClick={toggle}
                >
                  <span data-slot="session-turn-change-chevron">
                    <Show when={file.expandable}>
                      <Icon name="chevron-down" />
                    </Show>
                  </span>
                  <span data-slot="session-turn-change-path">{file.path}</span>
                  <span data-slot="session-turn-change-meta">
                    <Show
                      when={file.additions !== undefined || file.deletions !== undefined}
                      fallback={
                        <span data-slot="session-turn-change-status">{props.statusLabel(file.status)}</span>
                      }
                    >
                      <span data-slot="session-turn-changes-additions">+{file.additions ?? 0}</span>
                      <span data-slot="session-turn-changes-deletions">-{file.deletions ?? 0}</span>
                    </Show>
                    <Show when={file.large && file.restoreAvailable === false}>
                      <span data-slot="session-turn-change-unrestorable">
                        {i18n.t("ui.sessionTurn.turnChanges.unrestorable")}
                      </span>
                    </Show>
                  </span>
                  <span data-slot="session-turn-change-actions" onClick={(event) => event.stopPropagation()}>
                    <Tooltip value={i18n.t("ui.sessionTurn.turnChanges.openFile")} placement="top">
                      <IconButton
                        icon="open-file"
                        size="small"
                        variant="ghost"
                        aria-label={i18n.t("ui.sessionTurn.turnChanges.openFile")}
                        disabled={file.status === "deleted" || !file.openPath || !props.openFile}
                        onClick={() => file.openPath && props.openFile?.(file.openPath)}
                      />
                    </Tooltip>
                    <Tooltip value={i18n.t("ui.sessionTurn.turnChanges.showInFolder")} placement="top">
                      <IconButton
                        icon="folder-add-left"
                        size="small"
                        variant="ghost"
                        aria-label={i18n.t("ui.sessionTurn.turnChanges.showInFolder")}
                        disabled={!file.openPath || !props.showInFolder}
                        onClick={() =>
                          file.openPath &&
                          props.showInFolder?.(
                            file.status === "deleted" ? getDirectory(file.openPath) : file.openPath,
                          )
                        }
                      />
                    </Tooltip>
                  </span>
                </div>
                <Show when={expanded() && view()}>
                  {(diff) => (
                    <div data-slot="session-turn-change-diff" data-scrollable>
                      <Dynamic component={fileComponent} mode="diff" fileDiff={diff().fileDiff} />
                    </div>
                  )}
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      <Show when={(props.change.skippedCount ?? 0) > 0}>
        <div data-slot="session-turn-changes-skipped-notice">
          {i18n.t("ui.sessionTurn.turnChanges.skippedNotice", { count: props.change.skippedCount ?? 0 })}
        </div>
      </Show>
    </div>
  )
}
