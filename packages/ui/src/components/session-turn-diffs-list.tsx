import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { Accordion } from "./accordion"
import { StickyAccordionHeader } from "./sticky-accordion-header"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"
import { normalize } from "./session-diff"

/**
 * Slice 11b.1: legacy diffs accordion extracted from `session-turn.tsx`
 * per design doc §2a.
 *
 * Rendered when the timeline doesn't carry a turn-change record (older
 * sessions / non-undo-aware flows). Shows up to `maxFiles` rows; the
 * "show all" toggle reveals the rest. Each row is a sticky-header
 * accordion that lazy-mounts its diff body one animation frame after
 * the user opens it — this keeps the open transition smooth even when
 * the diff is large.
 */

export type SessionTurnDiffsListProps = {
  diffs: SnapshotFileDiff[]
  visible: SnapshotFileDiff[]
  edited: number
  overflow: number
  showAll: boolean
  toggleAll: () => void
  expanded: string[]
  onExpandedChange: (next: string[]) => void
}

export function SessionTurnDiffsList(props: SessionTurnDiffsListProps) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={props.showAll || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {props.edited} {i18n.t("ui.sessionTurn.diffs.changed")}{" "}
          {i18n.t(props.edited === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={props.overflow > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={props.toggleAll}>
            {props.showAll ? i18n.t("ui.sessionTurn.diffs.showLess") : i18n.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={props.expanded}
          onChange={(value) => props.onExpandedChange(Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={props.visible}>
            {(diff) => {
              const view = normalize(diff)
              const active = createMemo(() => props.expanded.includes(diff.file))
              const [shown, setShown] = createSignal(false)

              createEffect(
                on(
                  active,
                  (value) => {
                    if (!value) {
                      setShown(false)
                      return
                    }

                    requestAnimationFrame(() => {
                      if (!active()) return
                      setShown(true)
                    })
                  },
                  { defer: true },
                ),
              )

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div data-slot="session-turn-diff-trigger">
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">
                              {`‪${getDirectory(diff.file)}‬`}
                            </span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes">
                            <DiffChanges changes={diff} />
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={shown()}>
                      <div data-slot="session-turn-diff-view" data-scrollable>
                        <Dynamic component={fileComponent} mode="diff" fileDiff={view.fileDiff} />
                      </div>
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!props.showAll && props.overflow > 0}>
          <div data-slot="session-turn-diffs-more" onClick={props.toggleAll}>
            {i18n.t("ui.sessionTurn.diffs.more", { count: String(props.overflow) })}
          </div>
        </Show>
      </div>
    </div>
  )
}
