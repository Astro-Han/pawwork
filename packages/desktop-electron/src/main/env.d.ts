interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly PAWWORK_FEEDBACK_FORM_URL?: string
  readonly PAWWORK_BUILD_SHA?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  // A typed handle for an opencode Effect crossing the virtual-module boundary.
  // The desktop side never inspects it; AppRuntime.runPromise unwraps it to the
  // Result type, so a handler that returns the wrong shape — or a callback that
  // calls the wrong service method — fails typecheck instead of only at runtime.
  export type ServerEffect<Result> = { readonly __result?: Result }

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
      lspEnabled: () => ServerEffect<boolean>
      setLspEnabled: (value: boolean) => ServerEffect<void>
      webSearchEnabled: () => ServerEffect<boolean>
      setWebSearchEnabled: (value: boolean) => ServerEffect<void>
    }
    export const Service: {
      use: <A>(fn: (settings: ServiceApi) => A) => A
    }
  }

  export namespace AppRuntime {
    export function runPromise<Result>(effect: ServerEffect<Result>, options?: unknown): Promise<Result>
  }

  export namespace WebSearchAuth {
    export type Status = {
      source: "saved" | "env" | "anonymous"
      configured: boolean
      needsAttention: boolean
      quotaExceeded: boolean
    }
    export type ServiceApi = {
      status: () => ServerEffect<Status>
      saveKey: (key: string) => ServerEffect<Status>
      removeKey: () => ServerEffect<Status>
    }
    export const Service: {
      use: <A>(fn: (auth: ServiceApi) => A) => A
    }
  }

  export namespace LSP {
    export type ServiceApi = {
      shutdownAll: () => ServerEffect<void>
      invalidate: () => ServerEffect<void>
    }
    export const Service: {
      use: <A>(fn: (lsp: ServiceApi) => A) => A
    }
  }

  export namespace ToolRegistry {
    export type ServiceApi = {
      invalidate: () => ServerEffect<void>
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
