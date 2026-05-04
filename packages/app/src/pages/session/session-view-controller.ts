import { createMemo, type Accessor } from "solid-js"

export type SessionViewStateInput = {
  directory: string
  routeSessionID: string | undefined
  routeMessagesReady: boolean
  previous?: SessionViewState
}

export type SessionViewState = {
  routeSessionID: string | undefined
  routeReady: boolean
  visibleSessionID: string | undefined
  transitioning: boolean
  routeSessionKey: string
  visibleSessionKey: string
}

export type SessionViewControllerInput = {
  directory: Accessor<string>
  routeSessionID: Accessor<string | undefined>
  routeMessagesReady: Accessor<boolean>
}

export function sessionKey(input: { sessionID: string | undefined }) {
  return input.sessionID ?? ""
}

export function nextSessionViewState(input: SessionViewStateInput) {
  const sameSession =
    input.previous?.routeSessionID === input.routeSessionID &&
    input.previous?.visibleSessionID === input.routeSessionID &&
    !!input.routeSessionID
  const keepReady = sameSession && !!input.previous?.routeReady && !input.routeMessagesReady
  const routeReady = !input.routeSessionID || input.routeMessagesReady || keepReady
  const visibleSessionID = input.routeSessionID

  return {
    routeSessionID: input.routeSessionID,
    routeReady,
    visibleSessionID,
    transitioning: !routeReady,
    routeSessionKey: sessionKey({ sessionID: input.routeSessionID }),
    visibleSessionKey: sessionKey({ sessionID: visibleSessionID }),
  }
}

export function createSessionViewController(input: SessionViewControllerInput) {
  type State = SessionViewState & { directory: string }
  const state = createMemo((current: State | undefined): State => {
    const directory = input.directory()
    return {
      ...nextSessionViewState({
        directory,
        routeSessionID: input.routeSessionID(),
        routeMessagesReady: input.routeMessagesReady(),
        previous: current,
      }),
      directory,
    }
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
