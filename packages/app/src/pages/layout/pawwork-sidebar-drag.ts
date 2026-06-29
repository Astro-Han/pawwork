import Sortable from "sortablejs"
import { onCleanup } from "solid-js"

/**
 * Sidebar drag-and-drop wiring for the sidebar session rows (issue #856).
 *
 * Patterns surfaced by the spike and the multi-round crosscheck loop:
 *
 * 1. Revert SortableJS's DOM mutation in onEnd. Solid's keyed `<For>` is the
 *    single source of truth; without the revert, no-op drags (back to origin)
 *    orphan the moved node and produce duplicate rows on next render.
 * 2. Use `newDraggableIndex` (not `newIndex`) so a non-draggable sibling
 *    cannot skew the insertion position. Bail rather than default to 0 when
 *    SortableJS omits it (degenerate / cancelled / clone-pull events).
 * 3. `emptyInsertThreshold: 32` — the default 5 is unreachable in practice.
 * 4. `forceFallback: true` + `fallbackOnBody: true` — avoid the HiDPI blurry
 *    native drag image; fallback uses pointer events.
 * 5. `sort: kind === "pinned"` — only the pinned list owns positional state.
 *    Recent and project-group lists are derived; intra-list reorder there
 *    would visibly shuffle then snap back, which is misleading.
 * 6. `fallbackTolerance: 5` — a movement dead zone so an ordinary click with a
 *    little hand jitter is not mistaken for a drag (default is 0, which eats
 *    the click and makes the row feel unresponsive).
 *
 * Project mode: project groups also accept drag, but ONLY for drops from
 * pinned (a session's project is derived from its directory and is read-only;
 * cross-group drags would visually mislead). The `put` callback enforces it.
 *
 * `onCleanup` is invoked inside the returned ref callback, which executes
 * during JSX evaluation. For elements rendered under `<Show>`, that
 * evaluation runs inside the Show branch's createMemo owner, so the cleanup
 * disposes with the branch — no leak across mount/unmount cycles.
 */

export type SortableKind = "pinned" | "recent" | "project-group"

export type SortableDragHandler = (input: {
  sessionID: string
  targetSection: "pinned" | "recent"
  visiblePinnedIDs: string[]
  visibleTargetIndex: number
}) => void

export type SortableAttacherDeps = {
  /** Called when a drag commits a state-changing drop. */
  onDragSession?: SortableDragHandler
  /** Toggled true on dragstart and false on dragend (drives "按需浮现"). */
  setIsDragging: (value: boolean) => void
  /** Reactive accessor for the rendered pinned session ids, in render order. */
  getVisiblePinnedIDs: () => string[]
}

export function createSortableAttacher(deps: SortableAttacherDeps) {
  return (kind: SortableKind) => (el: HTMLDivElement | undefined) => {
    if (!el) return
    const handler = deps.onDragSession
    if (!handler) return
    el.dataset.pawworkList = kind

    const group: Sortable.Options["group"] =
      kind === "project-group"
        ? {
            name: "pawwork-sessions",
            pull: true,
            // Only accept from the pinned zone. Cross-project drags would be
            // visually inconsistent — the row would snap back since project
            // assignment is read-only.
            put: (_to, from) => (from.el as HTMLElement).dataset.pawworkList === "pinned",
          }
        : { name: "pawwork-sessions", pull: true, put: true }

    const instance = Sortable.create(el, {
      group,
      animation: 150,
      forceFallback: true,
      fallbackOnBody: true,
      // Click and drag share one mousedown on the same row. Default
      // fallbackTolerance is 0, so any ~1px hand jitter during a click is read
      // as a drag — that swallows the click, navigation never fires, and the
      // row feels slow/unresponsive (issue: clicking the sidebar title). A
      // small movement dead zone keeps still clicks as clicks; only deliberate
      // movement starts a drag. forceFallback routes touch through the same
      // fallback path, so this one threshold covers mouse and touch (the
      // touchStartThreshold option is inert here — it only applies while `delay`
      // is counting down, which we don't use).
      fallbackTolerance: 5,
      scroll: true,
      bubbleScroll: true,
      emptyInsertThreshold: 32,
      draggable: ".pw-drag-row",
      ghostClass: "pw-drag-ghost",
      chosenClass: "pw-drag-chosen",
      dragClass: "pw-drag-active",
      sort: kind === "pinned",
      onStart: () => deps.setIsDragging(true),
      onEnd: (evt) => {
        deps.setIsDragging(false)
        // The drag wrapper explicitly tags itself with the session it represents
        // (`data-pw-drag-session-id`). Reading the attribute on the dragged
        // node itself avoids depending on descendant-render order — important
        // because SessionItem may render an active child row inside the same
        // wrapper, and a naive `querySelector('[data-session-id]')` would
        // return whichever child element happens to be first in the subtree.
        const sessionID = (evt.item as HTMLElement).dataset.pwDragSessionId
        const toKind = (evt.to as HTMLElement).dataset.pawworkList as SortableKind | undefined
        const newDraggableIndex = evt.newDraggableIndex

        // Revert SortableJS's DOM mutation; Solid's <For> reconciler owns the
        // DOM. Skip the revert if SortableJS already detached the node (e.g.
        // a cloned-pull drop or a cancelled drag may leave parentNode null).
        if (evt.item.parentNode) {
          evt.item.parentNode.removeChild(evt.item)
        }
        const fromContainer = evt.from as HTMLElement
        const oldIndex = typeof evt.oldIndex === "number" ? evt.oldIndex : fromContainer.children.length
        const referenceNode = fromContainer.children[oldIndex] ?? null
        fromContainer.insertBefore(evt.item, referenceNode)

        if (!sessionID || !toKind) return

        // SortableJS should always set newDraggableIndex when the dragged
        // node carries `draggable=true` and lands in a draggable slot. If it
        // doesn't, the event is degenerate (cancelled / clone-pull / fallback
        // edge); bailing is safer than defaulting to 0 and silently inserting
        // at the top of pinned.
        if (typeof newDraggableIndex !== "number") return

        // No-op drag: dropped back into the same container at the same slot.
        const oldDraggableIndex = evt.oldDraggableIndex
        if (
          evt.to === evt.from &&
          typeof oldDraggableIndex === "number" &&
          oldDraggableIndex === newDraggableIndex
        ) {
          return
        }

        // Map project-group drop to "recent" semantics: both mean "not pinned".
        // The row settles into its own project group on next render.
        const targetSection: "pinned" | "recent" = toKind === "pinned" ? "pinned" : "recent"
        handler({
          sessionID,
          targetSection,
          visiblePinnedIDs: deps.getVisiblePinnedIDs(),
          visibleTargetIndex: newDraggableIndex,
        })
      },
    })

    onCleanup(() => instance.destroy())
  }
}
