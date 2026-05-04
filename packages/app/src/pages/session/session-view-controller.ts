import { createMemo, type Accessor } from "solid-js"

export type SessionViewStateInput = {
  directory: string
  routeSessionID: string | undefined
  routeMessagesReady: boolean
}

export type SessionViewControllerInput = {
  directory: Accessor<string>
  routeSessionID: Accessor<string | undefined>
  routeMessagesReady: Accessor<boolean>
}

export function sessionKey(input: { directory: string; sessionID: string | undefined }) {
  return `${input.directory}${input.sessionID ? `/${input.sessionID}` : ""}`
}

export function nextSessionViewState(input: SessionViewStateInput) {
  const routeReady = !input.routeSessionID || input.routeMessagesReady
  const visibleSessionID = input.routeSessionID

  return {
    routeSessionID: input.routeSessionID,
    routeReady,
    visibleSessionID,
    transitioning: !routeReady,
    routeSessionKey: sessionKey({ directory: input.directory, sessionID: input.routeSessionID }),
    visibleSessionKey: sessionKey({ directory: input.directory, sessionID: visibleSessionID }),
  }
}

export function createSessionViewController(input: SessionViewControllerInput) {
  type State = ReturnType<typeof nextSessionViewState> & { directory: string }
  const state = createMemo((current: State | undefined): State => {
    const directory = input.directory()
    return {
      ...nextSessionViewState({
        directory,
        routeSessionID: input.routeSessionID(),
        routeMessagesReady: input.routeMessagesReady(),
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
