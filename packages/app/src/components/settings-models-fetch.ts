export type FetchedModel = { id: string; name: string }

export type MergeFetchedModelsInput = {
  // Model IDs the provider already exposes (catalog + existing config), used to decide what is new.
  existingModelIDs: Iterable<string>
  // Current config.provider.<id>.models, preserved so a re-fetch never drops prior additions.
  configModels?: Record<string, { name?: string }>
  fetched: FetchedModel[]
}

export type MergeFetchedModelsResult = {
  // The next config.provider.<id>.models map to persist (existing config entries + newly added).
  models: Record<string, { name: string }>
  added: number
  skipped: number
}

// Merge live-fetched models into a provider's config model overrides. Only models the provider does not
// already expose are added (name defaults to id); existing config entries are preserved and duplicates
// skipped. Catalog models are never written to config — they already resolve from the catalog. Issue #1463.
export function mergeFetchedModels(input: MergeFetchedModelsInput): MergeFetchedModelsResult {
  const present = new Set(input.existingModelIDs)
  const models: Record<string, { name: string }> = {}

  for (const [id, model] of Object.entries(input.configModels ?? {})) {
    models[id] = { name: model.name ?? id }
    present.add(id)
  }

  let added = 0
  let skipped = 0
  const seen = new Set<string>()
  for (const model of input.fetched) {
    const id = model.id.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (present.has(id)) {
      skipped++
      continue
    }
    models[id] = { name: model.name.trim() || id }
    present.add(id)
    added++
  }

  return { models, added, skipped }
}
