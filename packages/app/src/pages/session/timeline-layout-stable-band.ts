export const TIMELINE_BASE_OVERSCAN = 8
export const TIMELINE_TRANSACTION_OVERSCAN = 24

export function chooseTimelineVirtualizerOverscan(input: { transactionActive: boolean }) {
  return input.transactionActive ? TIMELINE_TRANSACTION_OVERSCAN : TIMELINE_BASE_OVERSCAN
}
