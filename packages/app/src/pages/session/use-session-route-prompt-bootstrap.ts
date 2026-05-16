import { createEffect, on, untrack } from "solid-js"

interface SessionRoutePromptBootstrapOptions {
  ready: () => boolean
  sessionID: () => string | undefined
  prompt: () => string | undefined
  setPrompt: (text: string) => void
  clearPrompt: () => void
}

export function useSessionRoutePromptBootstrap(options: SessionRoutePromptBootstrapOptions) {
  createEffect(
    on(
      () => [options.ready(), options.sessionID(), options.prompt()] as const,
      ([ready, sessionID, text]) => {
        if (!ready || sessionID || !text) return
        untrack(() => {
          options.setPrompt(text)
          options.clearPrompt()
        })
      },
    ),
  )
}
