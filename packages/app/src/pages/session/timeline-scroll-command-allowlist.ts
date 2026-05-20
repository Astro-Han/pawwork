import type { TimelineScrollOwnershipAllowlistEntry } from "./timeline-scroll-ownership-guard"

export const timelineScrollCommandAllowlist: TimelineScrollOwnershipAllowlistEntry[] = [
  {
    filePath: "packages/app/src/pages/session/composer/session-question-dock.tsx",
    symbol: "keepVisibleInQuestionOptions",
    reason: "Question option list is a nested composer scroller, not the session timeline viewport.",
    owner: "session composer",
    removal: "Remove when nested composer option scrolling is routed through a dedicated non-timeline helper.",
  },
  {
    filePath: "packages/app/src/pages/session/file-tabs.tsx",
    symbol: "restore",
    reason: "File tab restoration targets the file panel scroller, not the session timeline viewport.",
    owner: "file tabs",
    removal: "Remove when file panel scroll restoration is moved behind its own reviewed helper.",
  },
  {
    filePath: "packages/app/src/pages/session/review-tab.tsx",
    symbol: "doRestore",
    reason: "Review tab restoration targets the review panel scroller, not the session timeline viewport.",
    owner: "review panel",
    removal: "Remove when review panel scroll restoration is moved behind its own reviewed helper.",
  },
  {
    filePath: "packages/app/src/pages/session/review-panel-scroll.ts",
    symbol: "scrollToReviewDiff",
    reason: "Review diff navigation targets the review panel scroller, not the session timeline viewport.",
    owner: "review panel",
    removal: "Remove when review panel diff navigation is moved behind its own reviewed helper.",
  },
]
