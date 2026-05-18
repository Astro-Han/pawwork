import type { Terminal as Term } from "ghostty-web"

export type KeyHandlerResult = "block" | "passthrough"

// Ghostty's customKeyEventHandler returns `true` to BLOCK default handling —
// opposite of xterm.js, which uses `true` to mean "continue normal processing".
// This wrapper exposes an enum so callers cannot accidentally invert the
// boolean and silently swallow every keystroke (see issue #696).
export const attachKeyHandler = (term: Term, handler: (event: KeyboardEvent) => KeyHandlerResult) => {
  term.attachCustomKeyEventHandler((event) => handler(event) === "block")
}
