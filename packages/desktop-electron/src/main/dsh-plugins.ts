import { decideDshNavigation } from "./window-navigation"

type CommunityMarketAction = "enable" | "status"

type RequestDshCommunityMarketOptions = {
  action: CommunityMarketAction
  dshUrl: string
  fetchImpl?: typeof fetch
  hostToken: string
}

export function assertDshPluginRequest(options: {
  dshUrl: string
  isMainFrame: boolean
  senderUrl: string
}) {
  if (!options.isMainFrame || decideDshNavigation(options.dshUrl, options.senderUrl) !== "same-window") {
    throw new Error("DSH plugin requests must come from the owned product frame")
  }
}

export async function requestDshCommunityMarket(options: RequestDshCommunityMarketOptions) {
  const response = await (options.fetchImpl ?? fetch)(
    new URL(`/pawwork/community-market/${options.action}`, options.dshUrl).href,
    {
      headers: { "x-pawwork-host-token": options.hostToken },
      method: options.action === "status" ? "GET" : "POST",
    },
  )
  const body = await response.json() as { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `DSH community market request failed (${response.status})`)
  }
  return body
}
