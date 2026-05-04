import { createMemo, type Accessor } from "solid-js"

export type TimelineIdentity = string

export type SessionViewStateInput = {
  routeSessionID: string | undefined
  routeMessagesReady: boolean
  previous?: SessionViewState
}

export type SessionViewState = {
  routeSessionID: string | undefined
  routeReady: boolean
  visibleSessionID: string | undefined
  transitioning: boolean
  routeSessionKey: TimelineIdentity
  visibleSessionKey: TimelineIdentity
}

export type SessionViewControllerInput = {
  routeSessionID: Accessor<string | undefined>
  routeMessagesReady: Accessor<boolean>
}

export function timelineIdentity(input: { sessionID: string | undefined }): TimelineIdentity {
  // Timeline identity follows the stable session only; execution directory is mutable.
  return input.sessionID ?? ""
}

export const sessionKey = timelineIdentity

export function nextSessionViewState(input: SessionViewStateInput) {
  const sameSession =
    input.previous?.routeSessionID === input.routeSessionID &&
    input.previous?.visibleSessionID === input.routeSessionID &&
    !!input.routeSessionID
  // A same-session directory cache miss is a loading state, not a timeline identity change.
  const keepReady = sameSession && !!input.previous?.routeReady && !input.routeMessagesReady
  const routeReady = !input.routeSessionID || input.routeMessagesReady || keepReady
  const visibleSessionID = input.routeSessionID

  return {
    routeSessionID: input.routeSessionID,
    routeReady,
    visibleSessionID,
    transitioning: !routeReady,
    routeSessionKey: timelineIdentity({ sessionID: input.routeSessionID }),
    visibleSessionKey: timelineIdentity({ sessionID: visibleSessionID }),
  }
}

export function createSessionViewController(input: SessionViewControllerInput) {
  const state = createMemo((current: SessionViewState | undefined): SessionViewState => {
    return nextSessionViewState({
      routeSessionID: input.routeSessionID(),
      routeMessagesReady: input.routeMessagesReady(),
      previous: current,
    })
  })

  const visibleReady = () => state().routeReady

  return {
    route: {
      id: () => state().routeSessionID,
      key: () => state().routeSessionKey,
      ready: () => state().routeReady,
    },
    visible: {
      id: () => state().visibleSessionID,
      key: () => state().visibleSessionKey,
      ready: visibleReady,
    },
    transitioning: () => state().transitioning,
  }
}
