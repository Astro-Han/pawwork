interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly PAWWORK_FEEDBACK_FORM_URL?: string
  readonly PAWWORK_BUILD_SHA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export type Listener = {
      hostname: string
      port: number
      url: URL
      stop: (close?: boolean) => Promise<void>
    }

    export function listen(opts: {
      port: number
      hostname: string
      mdns?: boolean
      mdnsDomain?: string
      cors?: string[]
    }): Promise<Listener>
  }

  export namespace Log {
    export function init(options: {
      print: boolean
      dev?: boolean
      level?: "DEBUG" | "INFO" | "WARN" | "ERROR"
    }): Promise<void>
  }

  export namespace Settings {
    export type ServiceApi = {
      lspEnabled: () => unknown
      setLspEnabled: (value: boolean) => unknown
      webSearchEnabled: () => unknown
      setWebSearchEnabled: (value: boolean) => unknown
    }
    export const Service: {
      use: <A>(fn: (settings: ServiceApi) => A) => A
    }
  }

  export namespace AppRuntime {
    export function runPromise(effect: unknown, options?: unknown): Promise<unknown>
  }

  export namespace WebSearchAuth {
    export type Status = {
      source: "saved" | "env" | "anonymous"
      configured: boolean
      needsAttention: boolean
      quotaExceeded: boolean
    }
    export type ServiceApi = {
      status: () => unknown
      saveKey: (key: string) => unknown
      removeKey: () => unknown
    }
    export const Service: {
      use: <A>(fn: (auth: ServiceApi) => A) => A
    }
  }

  export namespace LSP {
    export type ServiceApi = {
      shutdownAll: () => unknown
      invalidate: () => unknown
    }
    export const Service: {
      use: <A>(fn: (lsp: ServiceApi) => A) => A
    }
  }

  export namespace ToolRegistry {
    export type ServiceApi = {
      invalidate: () => unknown
    }
    export const Service: {
      use: <A>(fn: (registry: ServiceApi) => A) => A
    }
  }

  export namespace Instance {
    export function directories(): string[]
    export function provide<R>(input: {
      directory: string
      init?: () => Promise<unknown>
      fn: () => R
    }): Promise<R>
  }

  export namespace BrowserBridge {
    export type Endpoint = { cdpEndpoint: string }
    export interface Host {
      resolveEndpoint(input: { sessionID: string }): Promise<Endpoint>
      probeSession(input: { sessionID: string }): Promise<{ url: string | null }>
      releaseSession(input: { sessionID: string }): Promise<void>
      disposeSession(input: { sessionID: string }): Promise<void>
    }
    export function provideHost(host: Host | null): void
  }
}
