import { createMemo, type Accessor } from "solid-js"
import { sameSessionScope, sessionScopeKey, type SessionScope } from "./session-scope"

export type TimelineIdentity = string

export type SessionViewStateInput = {
  routeSessionID: string | undefined
  routeScope: SessionScope | undefined
  routeMessagesReady: boolean
  previous?: SessionViewState
}

export type SessionViewState = {
  routeSessionID: string | undefined
  routeReady: boolean
  routeSessionScope: SessionScope | undefined
  visibleSessionID: string | undefined
  visibleSessionScope: SessionScope | undefined
  transitioning: boolean
  routeSessionKey: TimelineIdentity
  visibleSessionKey: TimelineIdentity
}

export type SessionViewControllerInput = {
  routeSessionID: Accessor<string | undefined>
  routeScope: Accessor<SessionScope | undefined>
  routeMessagesReady: Accessor<boolean>
}

export function timelineIdentity(input: { scope: SessionScope | undefined }): TimelineIdentity {
  // Timeline identity follows the stable session only; execution directory is mutable.
  return sessionScopeKey(input.scope)
}

export const sessionKey = timelineIdentity

export function nextSessionViewState(input: SessionViewStateInput) {
  const sameSession =
    sameSessionScope(input.previous?.routeSessionScope, input.routeScope) &&
    sameSessionScope(input.previous?.visibleSessionScope, input.routeScope) &&
    !!input.routeScope
  // A same-session directory cache miss is a loading state, not a timeline identity change.
  const keepReady = sameSession && !!input.previous?.routeReady && !input.routeMessagesReady
  const routeReady = !input.routeSessionID || input.routeMessagesReady || keepReady
  const visibleSessionID = input.routeSessionID

  return {
    routeSessionID: input.routeSessionID,
    routeSessionScope: input.routeScope,
    routeReady,
    visibleSessionID,
    visibleSessionScope: input.routeScope,
    transitioning: !routeReady,
    routeSessionKey: timelineIdentity({ scope: input.routeScope }),
    visibleSessionKey: timelineIdentity({ scope: input.routeScope }),
  }
}

export function createSessionViewController(input: SessionViewControllerInput) {
  const state = createMemo((current: SessionViewState | undefined): SessionViewState => {
    return nextSessionViewState({
      routeSessionID: input.routeSessionID(),
      routeScope: input.routeScope(),
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
      scope: () => state().visibleSessionScope,
      key: () => state().visibleSessionKey,
      ready: visibleReady,
    },
    transitioning: () => state().transitioning,
  }
}
