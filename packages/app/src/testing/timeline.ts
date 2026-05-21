import { onCleanup, onMount } from "solid-js"

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

type TimelineEventTarget = Pick<Window, "addEventListener" | "removeEventListener">

export const timelineDriverDefaultTestRuntime = (env: { DEV?: boolean; TEST?: boolean } = import.meta.env) =>
  env.DEV || env.TEST

export const timelineDriverEnabled = (input?: { testRuntime?: boolean; windowRef?: TimelineWindow }) => {
  if (!input?.testRuntime) return false
  const win = input.windowRef ?? (typeof window === "undefined" ? undefined : (window as TimelineWindow))
  return win?.__opencode_e2e?.timeline?.enabled === true
}

export const bindTimelineDriver = (input: {
  testRuntime?: boolean
  timelineSessionID: () => string | undefined
  revealCached: () => void
  windowRef?: TimelineWindow & TimelineEventTarget
}) => {
  if (!input.testRuntime) return () => {}
  const win =
    input.windowRef ?? (typeof window === "undefined" ? undefined : (window as TimelineWindow & TimelineEventTarget))
  if (!win) return () => {}

  const handleTimelineDriver = (event: Event) => {
    if (!timelineDriverEnabled({ testRuntime: input.testRuntime, windowRef: win })) return
    const detail = (event as TimelineDriverEvent).detail
    if (detail?.sessionID && detail.sessionID !== input.timelineSessionID()) return
    if (detail?.action === "reveal-cached") input.revealCached()
  }

  win.addEventListener(timelineEvent, handleTimelineDriver)
  return () => win.removeEventListener(timelineEvent, handleTimelineDriver)
}

export function TimelineE2EDriverBoundary(props: {
  timelineSessionID: () => string | undefined
  revealCached: () => void
}) {
  onMount(() => {
    const cleanupTimelineDriver = bindTimelineDriver({
      testRuntime: timelineDriverDefaultTestRuntime(),
      timelineSessionID: props.timelineSessionID,
      revealCached: props.revealCached,
    })
    onCleanup(cleanupTimelineDriver)
  })

  return null
}
