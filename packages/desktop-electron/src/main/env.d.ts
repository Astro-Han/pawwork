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
    export function setWebSearchEnabled(value: boolean): Promise<void>
    export function webSearchEnabled(): Promise<boolean>
  }

  export namespace WebSearchAuth {
    export type Status = {
      source: "saved" | "env" | "anonymous"
      configured: boolean
      needsAttention: boolean
      quotaExceeded: boolean
    }
    export function status(): Promise<Status>
    export function saveKey(key: string): Promise<Status>
    export function removeKey(): Promise<Status>
  }

  export namespace BrowserBridge {
    export type NavigateResult = { url: string; title: string }
    export type ScreenshotResult = { mime: string; base64: string; width: number; height: number }
    export type ExtractResult = { url: string; title: string; text: string; truncated: boolean }
    export type WaitResult = { found: boolean; waitedMs: number; reason: "selector" | "text" | "timeout" }
    export type ClickResult = { matched: boolean; x: number; y: number }
    export type TypeResult = { matched: boolean; submitted: boolean }

    export interface Impl {
      navigate(input: { url: string }): Promise<NavigateResult>
      screenshot(): Promise<ScreenshotResult>
      extract(input: { selector?: string; maxChars: number }): Promise<ExtractResult>
      waitFor(input: { selector?: string; text?: string; timeoutMs: number }): Promise<WaitResult>
      click(input: { selector: string }): Promise<ClickResult>
      type(input: { selector?: string; text: string; submit: boolean }): Promise<TypeResult>
    }

    export function register(value: Impl): void
    export function unregister(): void
    export function available(): boolean
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
