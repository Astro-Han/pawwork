export const timelineScrollOwnershipFixtures = {
  directScrollTop: `
    export function bypass(viewport: HTMLElement) {
      viewport.scrollTop = 10
    }
  `,
  directScrollTo: `
    export function bypass(viewport: HTMLElement) {
      viewport.scrollTo({ top: 10 })
    }
  `,
  directScroll: `
    export function bypass(viewport: HTMLElement) {
      viewport.scroll({ top: 10 })
    }
  `,
  directScrollShorthandTop: `
    export function bypass(viewport: HTMLElement) {
      const top = 10
      viewport.scroll({ top })
    }
  `,
  directScrollSpreadOptions: `
    export function bypass(viewport: HTMLElement) {
      const opts = { top: 10 }
      viewport.scroll({ ...opts })
    }
  `,
  directScrollIntoView: `
    export function bypass(target: HTMLElement) {
      target.scrollIntoView({ block: "nearest" })
    }
  `,
  helperAlias: `
    export function bypass(viewport: HTMLElement) {
      const jump = viewport.scrollTo
      jump({ top: 10 })
    }
  `,
  computedScrollTop: `
    export function bypass(viewport: HTMLElement) {
      viewport["scrollTop"] = 10
    }
  `,
  scrollTopIncrement: `
    export function bypass(viewport: HTMLElement) {
      viewport.scrollTop++
    }
  `,
  fakeSinkAlias: `
    export function bypass(viewport: HTMLElement) {
      const sink = viewport
      sink.scrollTo({ top: 10 })
    }
  `,
  fakeNestedSinkProperty: `
    export function bypass(viewport: HTMLElement) {
      const wrapper = { fake_scrollCommandSink: viewport }
      wrapper.fake_scrollCommandSink.scrollTo({ top: 10 })
    }
  `,
  importedUtility: `
    import { scrollTimelineViewport } from "./scroll-utils"
    export function bypass(viewport: HTMLElement) {
      scrollTimelineViewport(viewport, 10)
    }
  `,
  virtualizerReveal: `
    import { revealTimelineRow } from "./virtualizer"
    export function bypass(row: string) {
      revealTimelineRow(row)
    }
  `,
  allowedSink: `
    import { createTimelineScrollCommandSink } from "./timeline-scroll-command-sink"
    export function ok(viewport: HTMLElement) {
      const sink = createTimelineScrollCommandSink()
      sink.setScrollTop({ element: viewport, top: 10, type: "anchor-restore", source: "fixture" })
    }
  `,
  allowedNonTimeline: `
    export function ok(panel: HTMLElement) {
      panel.scrollTop = 10
    }
  `,
} as const
