import { createMemo, createSignal } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { DOCK_MOTION } from "./motion"

// Shared collapse animation for composer dock widgets (Followup / Revert).
// Spring drives a 0..1 value (1 = collapsed). Caller observes contentRef via
// setContentRef; the hook computes a max-height that animates between 36
// (collapsed widget header — DESIGN.md L305) and the measured full content
// height.
//
// Todo dock keeps its own wiring because it layers a separate dockProgress
// signal (whole-dock fade) on top of this base animation.
export function useDockCollapse(collapsed: () => boolean) {
  const [height, setHeight] = createSignal(0)
  // contentRef is a signal so createResizeObserver reactively re-binds when
  // the JSX ref callback assigns the element. Earlier code stored the ref
  // in a plain variable inside a createEffect — it worked because the ref
  // callback fires before effects, but it's fragile and doesn't track
  // re-assignment.
  const [contentRef, setContentRef] = createSignal<HTMLDivElement>()
  createResizeObserver(contentRef, (rect) => setHeight(rect.height))

  const spring = useSpring(() => (collapsed() ? 1 : 0), DOCK_MOTION)
  const value = createMemo(() => Math.max(0, Math.min(1, spring())))
  const off = createMemo(() => value() > 0.98)
  const turn = createMemo(() => Math.max(0, Math.min(1, value())))
  const full = createMemo(() => Math.max(36, height()))
  const maxHeight = createMemo(() => `${Math.max(36, full() - value() * (full() - 36))}px`)

  return { setContentRef, value, off, turn, maxHeight }
}
