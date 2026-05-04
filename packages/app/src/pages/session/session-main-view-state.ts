export function shouldShowSessionOpeningState(input: {
  activeSessionID?: string
  routeSessionID?: string
  routeReady: boolean
  timelineSessionID?: string
}) {
  return (
    !!input.activeSessionID &&
    !!input.routeSessionID &&
    input.activeSessionID === input.routeSessionID &&
    input.timelineSessionID === input.routeSessionID &&
    !input.routeReady
  )
}
