import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2/client"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useFileComponent } from "../context/file"
import { useI18n } from "../context/i18n"
import { Accordion } from "./accordion"
import { DiffChanges } from "./diff-changes"
import { Icon } from "./icon"
import { createBoundedStateMap } from "./persisted-state-map"
import { normalize } from "./session-diff"
import { StickyAccordionHeader } from "./sticky-accordion-header"

const MAX_FILES = 10
const turnDiffState = createBoundedStateMap<{ showAll: boolean; expanded: string[] }>()

export function SessionTurnDiffs(props: {
  diffs: SnapshotFileDiff[]
  onShowAllToggle?: () => void
  stateKey?: string
}) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const persisted = props.stateKey ? turnDiffState.get(props.stateKey) : undefined
  const [state, setState] = createStore({
    showAll: persisted?.showAll ?? false,
    expanded: persisted?.expanded ?? ([] as string[]),
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const edited = createMemo(() => props.diffs.length)
  const overflow = createMemo(() => Math.max(0, edited() - MAX_FILES))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, MAX_FILES)))
  const toggleAll = () => {
    props.onShowAllToggle?.()
    const next = !showAll()
    setState("showAll", next)
    if (props.stateKey) turnDiffState.set(props.stateKey, { showAll: next, expanded: expanded() })
  }
  const setExpandedPersistent = (value: string[]) => {
    setState("expanded", value)
    if (props.stateKey) turnDiffState.set(props.stateKey, { showAll: showAll(), expanded: value })
  }

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {edited()} {i18n.t("ui.sessionTurn.diffs.changed")}{" "}
          {i18n.t(edited() === 1 ? "ui.common.file.one" : "ui.common.file.other")}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={overflow() > 0}>
          <button type="button" data-slot="session-turn-diffs-toggle" onClick={toggleAll}>
            {showAll() ? i18n.t("ui.sessionTurn.diffs.showLess") : i18n.t("ui.sessionTurn.diffs.showAll")}
          </button>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setExpandedPersistent(Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const view = normalize(diff)
              const active = createMemo(() => expanded().includes(diff.file))
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
                              {`\u202A${getDirectory(diff.file)}\u202C`}
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
        <Show when={!showAll() && overflow() > 0}>
          <button type="button" data-slot="session-turn-diffs-more" onClick={toggleAll}>
            {i18n.t("ui.sessionTurn.diffs.more", { count: overflow() })}
          </button>
        </Show>
      </div>
    </div>
  )
}
