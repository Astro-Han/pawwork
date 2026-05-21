export const timelineEvent = "opencode:e2e:timeline"

export type TimelineDriverAction = "reveal-cached"

export type TimelineDriverEvent = CustomEvent<{
  action: TimelineDriverAction
  sessionID?: string
}>

export type TimelineWindow = Window & {
  __opencode_e2e?: {
    timeline?: {
      enabled?: boolean
    }
  }
}

export const timelineDriverEnabled = (input?: { testRuntime?: boolean; windowRef?: TimelineWindow }) => {
  if (!input?.testRuntime) return false
  const win = input.windowRef ?? (typeof window === "undefined" ? undefined : (window as TimelineWindow))
  return win?.__opencode_e2e?.timeline?.enabled === true
}
