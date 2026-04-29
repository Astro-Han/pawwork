import { createMemo, type Accessor } from "solid-js"

export type SessionViewStateInput = {
  currentVisibleDirectory?: string
  currentVisibleSessionID: string | undefined
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

export function nextVisibleSessionID(input: {
  current: string | undefined
  route: string | undefined
  routeReady: boolean
}) {
  if (!input.route) return undefined
  if (input.routeReady) return input.route
  return input.current
}

export function nextSessionViewState(input: SessionViewStateInput) {
  const routeReady = !input.routeSessionID || input.routeMessagesReady
  const currentVisibleSessionID =
    input.currentVisibleDirectory && input.currentVisibleDirectory !== input.directory
      ? undefined
      : input.currentVisibleSessionID
  const visibleSessionID = nextVisibleSessionID({
    current: currentVisibleSessionID,
    route: input.routeSessionID,
    routeReady,
  })

  return {
    routeSessionID: input.routeSessionID,
    routeReady,
    visibleSessionID,
    transitioning: visibleSessionID !== input.routeSessionID,
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
        currentVisibleDirectory: current?.directory,
        currentVisibleSessionID: current?.visibleSessionID,
        directory,
        routeSessionID: input.routeSessionID(),
        routeMessagesReady: input.routeMessagesReady(),
      }),
      directory,
    }
  })

  const visibleReady = () => {
    const next = state()
    if (!next.visibleSessionID) return !next.routeSessionID || next.routeReady
    if (next.visibleSessionID !== next.routeSessionID) return true
    return next.routeReady
  }

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
