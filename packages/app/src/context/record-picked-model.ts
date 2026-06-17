// A user's explicit pick in the desktop model picker is the only unambiguous
// signal that a model should become the recent default a model-less session
// (e.g. a Telegram /new) inherits. Mirror that one event to the server,
// best-effort: a failure must never disrupt the pick. Cycling or any other
// non-explicit set is intentionally ignored (no `recent` flag).
export interface RecentModelClient {
  provider: {
    recordRecent: (input: { providerID: string; modelID: string }) => Promise<unknown>
  }
}

export function recordPickedModel(
  client: RecentModelClient,
  item: { providerID: string; modelID: string } | undefined,
  options?: { recent?: boolean },
) {
  if (!item || !options?.recent) return
  void client.provider.recordRecent({ providerID: item.providerID, modelID: item.modelID }).catch(() => {})
}
