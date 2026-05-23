import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { getDirectory } from "@opencode-ai/core/util/path"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { Icon } from "./icon"
import { IconButton } from "./icon-button"
import { Tooltip } from "./tooltip"
import { normalize } from "./session-diff"
import {
  clampTurnChangeDiffReservedHeight,
  estimateTurnChangeDiffReservedHeight,
} from "./session-turn-change-diff-height"
import {
  hasTurnChangeActionHandler,
  turnChangeAction,
  turnChangeFiles,
  type TurnChangeActions,
  type TurnChangeDisplay,
  type TurnChangeFile,
} from "./session-turn-changes"

const emptyExpanded: readonly string[] = []
const TURN_CHANGE_STATIC_DIFF_MAX_PATCH_LINES = 800

function turnChangeDiffRenderStrategy(patch: string) {
  if (!patch) return "static"
  let count = 1
  for (let index = 0; index < patch.length; index += 1) {
    if (patch.charCodeAt(index) !== 10) continue
    count += 1
    if (count > TURN_CHANGE_STATIC_DIFF_MAX_PATCH_LINES) return "auto"
  }
  return "static"
}

export function SessionTurnChangesPanel(props: {
  turnChange: TurnChangeDisplay
  actions?: TurnChangeActions
  expanded?: readonly string[]
  onExpandedChange?: (value: string[]) => void
}) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  const turnFiles = createMemo(() => turnChangeFiles(props.turnChange))
  const appliedFiles = createMemo(() => turnFiles().filter((file) => file.restoreState === "applied"))
  const turnEdited = createMemo(() => appliedFiles().length)
  const turnAdditions = createMemo(() => appliedFiles().reduce((sum, file) => sum + (file.additions ?? 0), 0))
  const turnDeletions = createMemo(() => appliedFiles().reduce((sum, file) => sum + (file.deletions ?? 0), 0))
  const [confirmAction, setConfirmAction] = createSignal<"undo" | "redo" | undefined>()
  let confirmTimer: ReturnType<typeof setTimeout> | undefined
  const expandedPaths = () => props.expanded ?? emptyExpanded

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
    const id = props.turnChange.messageID ?? props.turnChange.turnID
    const action = turnChangeAction(props.turnChange)
    if (!id || !action || !hasTurnChangeActionHandler(props.turnChange, props.actions)) return
    if (!primeConfirm(action)) return
    resetConfirm()
    if (action === "undo") await props.actions?.undo?.(id)
    else await props.actions?.redo?.(id)
  }

  const turnActionLabel = createMemo(() => {
    const action = turnChangeAction(props.turnChange)
    if (!action) return ""
    const base =
      action === "undo" ? i18n.t("ui.sessionTurn.turnChanges.undo") : i18n.t("ui.sessionTurn.turnChanges.reapply")
    return confirmAction() === action
      ? action === "undo"
        ? i18n.t("ui.sessionTurn.turnChanges.undoConfirm")
        : i18n.t("ui.sessionTurn.turnChanges.redoConfirm")
      : base
  })

  const isUndoneTurn = createMemo(
    () => turnFiles().length > 0 && turnFiles().every((file) => file.restoreState === "undone"),
  )
  const turnStatusLabel = (status: TurnChangeFile["status"]) => {
    if (status === "added") return i18n.t("ui.sessionTurn.turnChanges.status.added")
    if (status === "deleted") return i18n.t("ui.sessionTurn.turnChanges.status.deleted")
    return i18n.t("ui.sessionTurn.turnChanges.status.updated")
  }

  return (
    <div data-slot="session-turn-changes" data-component="session-turn-changes">
      <div data-slot="session-turn-changes-header">
        <div data-slot="session-turn-changes-summary">
          <Show
            when={isUndoneTurn()}
            fallback={
              <>
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
              </>
            }
          >
            <span data-slot="session-turn-changes-undone-summary">
              {i18n.t(
                turnFiles().length === 1
                  ? "ui.sessionTurn.turnChanges.undoneSummary.one"
                  : "ui.sessionTurn.turnChanges.undoneSummary.other",
                { count: turnFiles().length },
              )}
            </span>
          </Show>
          <Show when={props.turnChange.truncated && (props.turnChange.omittedCount ?? 0) > 0}>
            <span data-slot="session-turn-changes-omitted">
              {i18n.t("ui.sessionTurn.turnChanges.omitted", { count: props.turnChange.omittedCount ?? 0 })}
            </span>
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
            const expanded = createMemo(() => expandedPaths().includes(file.path))
            const [measuredDiffHeight, setMeasuredDiffHeight] = createSignal<number>()
            let diffRef: HTMLDivElement | undefined
            const toggle = () => {
              if (!file.expandable) return
              const current = expandedPaths()
              props.onExpandedChange?.(
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
            createEffect(() => {
              view()
              setMeasuredDiffHeight(undefined)
            })
            const reservedDiffHeight = () => {
              const diff = view()
              if (!diff) return 0
              return (
                measuredDiffHeight() ?? estimateTurnChangeDiffReservedHeight({ ...diff.fileDiff, patch: diff.patch })
              )
            }
            const handleDiffRendered = () => {
              const measure = () => {
                if (!diffRef?.isConnected) return
                const content = diffRef.querySelector<HTMLElement>('[data-component="file"]')
                const height = clampTurnChangeDiffReservedHeight(content?.scrollHeight ?? diffRef.scrollHeight)
                setMeasuredDiffHeight(height)
              }

              if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure)
              else measure()
            }
            return (
              <div
                data-slot="session-turn-change-item"
                data-expanded={expanded() || undefined}
                data-restore-state={file.restoreState}
              >
                <div
                  data-component="session-turn-change-row"
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
                    <Show when={file.restoreState !== "applied"}>
                      <span data-slot="session-turn-change-restore-state">
                        {i18n.t(
                          file.restoreState === "undone"
                            ? "ui.sessionTurn.turnChanges.undone"
                            : "ui.sessionTurn.turnChanges.superseded",
                        )}
                      </span>
                    </Show>
                    <Show when={file.restoreState === "applied"}>
                      <Show
                        when={file.additions !== undefined || file.deletions !== undefined}
                        fallback={<span data-slot="session-turn-change-status">{turnStatusLabel(file.status)}</span>}
                      >
                        <span data-slot="session-turn-changes-additions">+{file.additions ?? 0}</span>
                        <span data-slot="session-turn-changes-deletions">-{file.deletions ?? 0}</span>
                      </Show>
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
                    <div
                      ref={(el) => (diffRef = el)}
                      data-component="session-turn-change-diff"
                      data-slot="session-turn-change-diff"
                      data-scrollable
                      style={{ "--turn-change-diff-reserved-height": `${reservedDiffHeight()}px` }}
                    >
                      <Dynamic
                        component={fileComponent}
                        mode="diff"
                        fileDiff={diff().fileDiff}
                        renderStrategy={turnChangeDiffRenderStrategy(diff().patch)}
                        onRendered={handleDiffRendered}
                      />
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
