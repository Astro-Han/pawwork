import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { decideDshNavigation } from "./window-navigation"

export const DSH_COMMUNITY_MARKET_TARGET = "dshmarket@1.21.0"

type DshCommand = {
  run(args: string[]): Promise<{ stderr: string; stdout: string }>
}

type ProfileManifest = {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

type CreateDshCommunityMarketManagerOptions = DshCommand & {
  home: string
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

async function readCommunityMarketStatus(home: string) {
  const manifest = JSON.parse(
    await readFile(join(home, "profiles", "web", "package.json"), "utf8"),
  ) as ProfileManifest
  const active = new Set(manifest.dsh?.profile?.bundles ?? [])
  const version = manifest.dependencies?.dshmarket ?? null
  return { enabled: version !== null && active.has("dshmarket"), version }
}

export function createDshCommunityMarketManager(options: CreateDshCommunityMarketManagerOptions) {
  let mutating = false

  return {
    status: () => readCommunityMarketStatus(options.home),
    async enable() {
      if (mutating) throw new Error("Another plugin operation is already running")
      mutating = true
      try {
        if ((await readCommunityMarketStatus(options.home)).enabled) return readCommunityMarketStatus(options.home)
        await options.run(["plugin", "--profile", "web", "add", DSH_COMMUNITY_MARKET_TARGET, "--save-exact"])
        return await readCommunityMarketStatus(options.home)
      } finally {
        mutating = false
      }
    },
  }
}
