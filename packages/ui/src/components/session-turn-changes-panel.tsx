import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { getDirectory } from "@opencode-ai/core/util/path"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"
import { normalize } from "./session-diff"
import {
  hasTurnChangeActionHandler,
  turnChangeAction,
  type TurnChangeActions,
  type TurnChangeDisplay,
  type TurnChangeFile,
} from "./session-turn-changes"

const emptyTurnFiles: TurnChangeFile[] = []

export function SessionTurnChangesPanel(props: {
  turnChange: TurnChangeDisplay
  actions?: TurnChangeActions
}) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const turnFiles = createMemo(() => props.turnChange.files ?? emptyTurnFiles)
  const turnEdited = createMemo(() => turnFiles().length)
  const turnAdditions = createMemo(() => turnFiles().reduce((sum, file) => sum + (file.additions ?? 0), 0))
  const turnDeletions = createMemo(() => turnFiles().reduce((sum, file) => sum + (file.deletions ?? 0), 0))
  const [turnExpanded, setTurnExpanded] = createSignal<string[]>([])
  const [confirmAction, setConfirmAction] = createSignal<"undo" | "redo" | undefined>()
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  const resetConfirm = () => {
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = undefined
    setConfirmAction(undefined)
  }
  const primeConfirm = (action: "undo" | "redo") => {
    if (confirmAction() === action) return true
    setConfirmAction(action)
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(resetConfirm, 3000)
    return false
  }
  onCleanup(resetConfirm)

  const mutateTurnChange = async () => {
    const id = props.turnChange.messageID
    const action = turnChangeAction(props.turnChange)
    if (!action || !hasTurnChangeActionHandler(props.turnChange, props.actions)) return
    if (!primeConfirm(action)) return
    resetConfirm()
    if (action === "undo") await props.actions?.undo?.(id)
    else await props.actions?.redo?.(id)
  }

  const turnActionLabel = createMemo(() => {
    const action = turnChangeAction(props.turnChange)
    if (!action) return ""
    const base = action === "undo" ? i18n.t("ui.sessionTurn.turnChanges.undo") : i18n.t("ui.sessionTurn.turnChanges.reapply")
    return confirmAction() === action
      ? action === "undo"
        ? i18n.t("ui.sessionTurn.turnChanges.undoConfirm")
        : i18n.t("ui.sessionTurn.turnChanges.redoConfirm")
      : base
  })

  const isUndoneTurn = createMemo(() => props.turnChange.redoAvailable && !props.turnChange.undoAvailable)
  const turnStatusLabel = (status: TurnChangeFile["status"]) => {
    if (status === "added") return i18n.t("ui.sessionTurn.turnChanges.status.added")
    if (status === "deleted") return i18n.t("ui.sessionTurn.turnChanges.status.deleted")
    return i18n.t("ui.sessionTurn.turnChanges.status.updated")
  }

  return (
    <div data-slot="session-turn-changes" data-component="session-turn-changes">
      <div data-slot="session-turn-changes-header">
        <div data-slot="session-turn-changes-summary">
          <span>
            {i18n.t(
              turnEdited() === 1
                ? "ui.sessionTurn.turnChanges.summary.one"
                : "ui.sessionTurn.turnChanges.summary.other",
              { count: turnEdited() },
            )}
          </span>
          <span data-slot="session-turn-changes-additions">+{turnAdditions()}</span>
          <span data-slot="session-turn-changes-deletions">-{turnDeletions()}</span>
          <Show when={props.turnChange.truncated && (props.turnChange.omittedCount ?? 0) > 0}>
            <span data-slot="session-turn-changes-omitted">
              {i18n.t("ui.sessionTurn.turnChanges.omitted", { count: props.turnChange.omittedCount ?? 0 })}
            </span>
          </Show>
          <Show when={isUndoneTurn()}>
            <span data-slot="session-turn-changes-undone">{i18n.t("ui.sessionTurn.turnChanges.undone")}</span>
          </Show>
        </div>
        <Show when={turnActionLabel() && hasTurnChangeActionHandler(props.turnChange, props.actions)}>
          <button
            type="button"
            data-slot="session-turn-changes-action"
            data-confirm={confirmAction() || undefined}
            onClick={mutateTurnChange}
            onMouseLeave={resetConfirm}
          >
            {turnActionLabel()}
          </button>
        </Show>
      </div>
      <div data-slot="session-turn-changes-list">
        <For each={turnFiles()}>
          {(file) => {
            const expanded = createMemo(() => turnExpanded().includes(file.path))
            const toggle = () => {
              if (!file.expandable) return
              setTurnExpanded((current) =>
                current.includes(file.path) ? current.filter((item) => item !== file.path) : [...current, file.path],
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
                      fallback={<span data-slot="session-turn-change-status">{turnStatusLabel(file.status)}</span>}
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
                        disabled={file.status === "deleted" || !file.openPath || !props.actions?.openFile}
                        onClick={() => file.openPath && props.actions?.openFile?.(file.openPath)}
                      />
                    </Tooltip>
                    <Tooltip value={i18n.t("ui.sessionTurn.turnChanges.showInFolder")} placement="top">
                      <IconButton
                        icon="folder-add-left"
                        size="small"
                        variant="ghost"
                        aria-label={i18n.t("ui.sessionTurn.turnChanges.showInFolder")}
                        disabled={!file.openPath || !props.actions?.showInFolder}
                        onClick={() =>
                          file.openPath &&
                          props.actions?.showInFolder?.(
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
      <Show when={(props.turnChange.skippedCount ?? 0) > 0}>
        <div data-slot="session-turn-changes-skipped-notice">
          {i18n.t("ui.sessionTurn.turnChanges.skippedNotice", {
            count: props.turnChange.skippedCount ?? 0,
          })}
        </div>
      </Show>
    </div>
  )
}
