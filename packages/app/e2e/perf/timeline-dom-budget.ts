import type { Page } from "@playwright/test"

const timelineMessageSelector = "[data-message-id]"
const timelineVirtualizerSelector = '[data-component="session-timeline-virtualizer"]'
const timelineVirtualRowSelector = '[data-component="session-virtual-row"]'

export type TimelineDomBudget = {
  hasVirtualizer: boolean
  totalRows: number
  mountedRows: number
  mountedMessages: number
  visibleRows: number
}

export function shouldAssertTimelineVirtualization(perfBranch: string) {
  return perfBranch !== "base"
}

export async function readTimelineDomBudget(page: Page): Promise<TimelineDomBudget> {
  return page.evaluate(
    ({ messageSelector, rowSelector, virtualizerSelector }) => {
      const virtualizer = document.querySelector(virtualizerSelector)
      const rows = Array.from(document.querySelectorAll(rowSelector))
      const messages = Array.from(document.querySelectorAll(messageSelector))
      const virtualizedTotalRows = Number((virtualizer as HTMLElement | null)?.dataset.totalRows ?? 0)
      return {
        hasVirtualizer: virtualizer instanceof HTMLElement,
        totalRows: virtualizedTotalRows > 0 ? virtualizedTotalRows : messages.length,
        mountedRows: rows.length,
        mountedMessages: messages.length,
        visibleRows: rows.filter((row) => {
          if (!(row instanceof HTMLElement)) return false
          const rect = row.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        }).length,
      }
    },
    {
      messageSelector: timelineMessageSelector,
      rowSelector: timelineVirtualRowSelector,
      virtualizerSelector: timelineVirtualizerSelector,
    },
  )
}
