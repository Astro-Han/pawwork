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

export const timelineDriverEnabled = () => {
  if (typeof window === "undefined") return false
  return (window as TimelineWindow).__opencode_e2e?.timeline?.enabled === true
}
