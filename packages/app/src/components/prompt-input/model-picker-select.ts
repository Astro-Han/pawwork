import type { ModelKey } from "@/context/models"

// Split out of model-picker.tsx so it can be unit-tested without loading the
// component (Kobalte pulls solid-js's client-only API, which throws under the
// server-condition test runtime). Mirrors sidebar-item-navigation.ts.
type ModelSetter = {
  set: (item: ModelKey | undefined, options?: { recent?: boolean }) => void
}

// The picker's one write path. An explicit pick always mirrors the choice to the
// server's recent-model default (the `{ recent: true }`), which a model-less
// session — a Telegram /new, say — then inherits. Dropping that flag is the
// regression model-picker.test.ts guards.
export function selectModel(model: ModelSetter, choice: { id: string; provider: { id: string } } | undefined) {
  model.set(choice ? { modelID: choice.id, providerID: choice.provider.id } : undefined, { recent: true })
}
