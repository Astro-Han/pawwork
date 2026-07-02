export const TIMELINE_BASE_OVERSCAN = 8
export const TIMELINE_ACTIVE_OVERSCAN = 24

// While the reconciler is settling an anchor (reveal-retry, history prepend,
// resize re-pin), widen the stable band so the target row stays mounted across
// the layout change and the reconciler never has to chase an unmounted anchor.
export function chooseTimelineVirtualizerOverscan(input: { reconcilerActive: boolean }) {
  return input.reconcilerActive ? TIMELINE_ACTIVE_OVERSCAN : TIMELINE_BASE_OVERSCAN
}
