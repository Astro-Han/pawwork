// Composer dock motion contract.
//
// Every spring-driven animation on the composer dock surface — segment
// mount/unmount, widget collapse/expand — runs on these options. Pinning
// them in one place makes the dock animation feel like one system rather
// than a collection of independent springs that drifted to similar values.
//
// visualDuration 0.3s: the de facto value across all composer springs (Todo
// collapse, Followup/Revert collapse via useDockCollapse, segment mount via
// session-composer-region). Slightly slower than --duration-slow (240ms CSS
// tier in theme.css) — acceptable because spring visualDuration is not
// strictly equivalent to a linear CSS transition duration; the spring's
// long tail past 98% completion is what makes it feel natural.
//
// bounce 0: matches the global useSpring convention (every callsite in the
// codebase uses bounce:0). Composer chrome stays critically damped — no
// overshoot.
//
// Followup work tracked in #34 (slice 10 docs PR):
//   - hoist this into a shared SPRING_TOKENS contract in @opencode-ai/ui
//     so non-composer callsites can reference the same tier ladder
//   - wire useSpring through prefers-reduced-motion (currently the global
//     CSS reduced-motion kill switch in theme.css does not affect JS-driven
//     inline-style spring animations)
export const DOCK_MOTION = {
  visualDuration: 0.3,
  bounce: 0,
} as const
