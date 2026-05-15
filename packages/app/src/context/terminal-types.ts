type Brand<T, Name extends string> = T & { readonly __brand: Name }

export type TerminalTabID = Brand<string, "TerminalTabID">
export type RuntimePTYID = Brand<string, "RuntimePTYID">

export type TerminalSnapshot = {
  size?: {
    rows: number
    cols: number
  }
  buffer?: string
  cursor?: number
  scrollY?: number
}

export type TerminalTab = {
  tabID: TerminalTabID
  title: string
  titleNumber: number
  order: number
  snapshot?: TerminalSnapshot
}

export type PersistedTerminalStateV2 = {
  version: 2
  activeTabID?: TerminalTabID
  tabs: TerminalTab[]
}

export function terminalTabID(value: string): TerminalTabID {
  return value as TerminalTabID
}

export function runtimePTYID(value: string): RuntimePTYID {
  return value as RuntimePTYID
}
