export function shouldShowSessionOpeningState(input: {
  activeSessionID?: string
  timelineSessionID?: string
  timelineMessagesReady: boolean
}) {
  return (
    !!input.activeSessionID &&
    !!input.timelineSessionID &&
    input.activeSessionID === input.timelineSessionID &&
    !input.timelineMessagesReady
  )
}
