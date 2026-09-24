import { decideDshNavigation } from "./window-navigation"

export function assertDshPluginRequest(options: {
  dshUrl: string
  isMainFrame: boolean
  senderUrl: string
}) {
  if (!options.isMainFrame || decideDshNavigation(options.dshUrl, options.senderUrl) !== "same-window") {
    throw new Error("DSH plugin requests must come from the owned product frame")
  }
}
