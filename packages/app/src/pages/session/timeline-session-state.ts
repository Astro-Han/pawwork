export function nextTimelineSessionID(input: {
  current: string | undefined
  route: string | undefined
  routeReady: boolean
}) {
  if (!input.route) return undefined
  if (input.routeReady) return input.route
  return input.current
}
