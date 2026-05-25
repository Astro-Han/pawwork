import type { RetryClassification } from "@opencode-ai/sdk/v2/client"
import { RateLimitCard } from "@opencode-ai/ui/rate-limit-card"
import { useShellSurface } from "../context/shell-surface"
import { trackEvent } from "../utils/events"

const SUBSCRIBE_URL = "https://opencode.ai/go?ref=V1WTSZKC69"
const DEEPSEEK_URL = "https://platform.deepseek.com/"

// openLink is exposed by the desktop-electron preload (packages/desktop-electron/src/preload/types.ts:97).
// The renderer-side window.api type in app.tsx declares only the subset of API the app actually uses;
// this declaration extends that with openLink for type-narrowing within this file.
type ApiWithOpenLink = NonNullable<Window["api"]> & { openLink?: (url: string) => void }

/**
 * App-layer owner of the RateLimitCard side effects. Holds the only three
 * things that cannot live in packages/ui:
 *   - window.api.openLink (Electron preload IPC)
 *   - trackEvent (app-level telemetry hook)
 *   - shellSurface.openSettings("providers")
 *
 * Passes pre-bound callbacks to the pure presentational RateLimitCard so
 * packages/ui stays framework-agnostic.
 */
export function RateLimitCardWiring(props: {
  classification: Extract<RetryClassification, { kind: "free_quota_exhausted" }>
}) {
  const shell = useShellSurface()
  return (
    <RateLimitCard
      classification={props.classification}
      onSubscribeClick={() => {
        trackEvent("rate_limit_card.subscribe_click", { providerID: props.classification.providerID })
        ;(window.api as ApiWithOpenLink | undefined)?.openLink?.(SUBSCRIBE_URL)
      }}
      onDeepSeekClick={() => {
        trackEvent("rate_limit_card.deepseek_click", { providerID: props.classification.providerID })
        ;(window.api as ApiWithOpenLink | undefined)?.openLink?.(DEEPSEEK_URL)
      }}
      onUseOwnModelClick={() => {
        trackEvent("rate_limit_card.byo_click", { providerID: props.classification.providerID })
        shell.openSettings("providers")
      }}
    />
  )
}
