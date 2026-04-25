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
    export function setLspEnabled(value: boolean): Promise<void>
    export function lspEnabled(): Promise<boolean>
  }

  export namespace LSP {
    export function shutdownAll(): Promise<void>
    export function invalidate(): Promise<void>
  }

  export namespace ToolRegistry {
    export function invalidate(): Promise<void>
  }

  export namespace Instance {
    export function directories(): string[]
    export function provide<R>(input: {
      directory: string
      init?: () => Promise<unknown>
      fn: () => R
    }): Promise<R>
  }
}
