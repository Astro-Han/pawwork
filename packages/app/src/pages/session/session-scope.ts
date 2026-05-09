export type SessionScope = {
  serverKey: string
  sessionID: string
}

export function makeSessionScope(input: {
  serverKey: string | undefined
  sessionID: string | undefined
}): SessionScope | undefined {
  if (!input.serverKey || !input.sessionID) return undefined
  return { serverKey: input.serverKey, sessionID: input.sessionID }
}

export function sessionScopeKey(scope: SessionScope | undefined) {
  if (!scope) return ""
  return JSON.stringify([scope.serverKey, scope.sessionID])
}

export function sameSessionScope(a: SessionScope | undefined, b: SessionScope | undefined) {
  if (!a || !b) return a === b
  return a.serverKey === b.serverKey && a.sessionID === b.sessionID
}
