import type { RemoteStatus } from "@/desktop-api-contract"

/** The slice of the remote bridge API the status sync needs. */
type StatusSource = {
  getStatus(): Promise<RemoteStatus>
  onStatus(handler: (status: RemoteStatus) => void): () => void
}

/**
 * Feed bridge status to `apply` without a slow initial snapshot clobbering a
 * fresher live update. onStatus is subscribed first; the one-shot getStatus()
 * snapshot is applied only if no live update has landed by the time it resolves,
 * so the page can't flip connected → disconnected on a late snapshot. Returns the
 * onStatus unsubscribe.
 */
export function subscribeRemoteStatus(source: StatusSource, apply: (status: RemoteStatus) => void): () => void {
  let sawLive = false
  const off = source.onStatus((status) => {
    sawLive = true
    apply(status)
  })
  void source.getStatus().then((status) => {
    if (!sawLive) apply(status)
  })
  return off
}
