import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo, type Accessor } from "solid-js"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "deepseek",
  "anthropic",
  "github-copilot",
  "openai",
  "volcengine-plan",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders(dirOverride?: Accessor<string | undefined>) {
  const globalSync = useGlobalSync()
  const params = useParams()
  // dirOverride is a raw directory (e.g. the Automations create card's selected
  // folder, which can differ from the current route). When provided it fully
  // replaces the route's encoded dir param, so providers/models can be scoped to
  // a directory other than the one in the URL.
  const dir = createMemo(() => (dirOverride ? (dirOverride() ?? "") : (decode64(params.dir) ?? "")))
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) => connected.has(p.id) && (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}
