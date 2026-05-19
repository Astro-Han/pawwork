export type RendererAbortSource = "autoHeal" | "ctrlG" | "emptyEnter" | "escape" | "revert" | "stopButton" | "undo"

export function rendererAbortDiagnosticSource(input: { sessionID: string; source: RendererAbortSource }) {
  if (!input.sessionID) throw new Error("sessionID is required for abort diagnostics")
  return `renderer.${input.source}`
}
