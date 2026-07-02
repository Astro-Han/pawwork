import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"
import { filterSystemHiddenModels } from "@/utils/hidden-models"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

export function listAvailableProviderModels<T extends { id: string }>(provider: {
  id: string
  models: Record<string, T>
}) {
  return filterSystemHiddenModels(provider.id, Object.values(provider.models))
}

export function listProviderModels<T extends { id: string }>(provider: {
  id: string
  models: Record<string, T>
}) {
  return Object.values(provider.models)
}

export function findProviderModel<T extends { id: string }>(
  providers: Array<{ id: string; models: Record<string, T> }>,
  key: ModelKey,
) {
  const provider = providers.find((item) => item.id === key.providerID)
  if (!provider) return
  return listProviderModels(provider).find((model) => model.id === key.modelID)
}

// The provider-derived model view (available list, latest/release, find,
// visibility filter) computed over one providers scope. Extracted from the
// context so the Automations create card can build a view scoped to its
// selected directory (see useScopedModels) instead of the route's, while still
// sharing the global, directory-independent user prefs (visibility map).
export function createModelsView(
  providers: ReturnType<typeof useProviders>,
  visibility: Accessor<Map<string, Visibility>>,
) {
  const available = createMemo(() =>
    providers.connected().flatMap((p) =>
      listAvailableProviderModels(p).map((m) => ({
        ...m,
        provider: p,
      })),
    ),
  )

  const release = createMemo(
    () =>
      new Map(
        available().map((model) => {
          const parsed = DateTime.fromISO(model.release_date)
          return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
        }),
      ),
  )

  const latest = createMemo(() =>
    pipe(
      available(),
      filter(
        (x) =>
          Math.abs(
            (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
              .diffNow()
              .as("months"),
          ) < 6,
      ),
      groupBy((x) => x.provider.id),
      mapValues((models) =>
        pipe(
          models,
          groupBy((x) => x.family),
          values(),
          (groups) =>
            groups.flatMap((g) => {
              const first = firstBy(g, [(x) => x.release_date, "desc"])
              return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
            }),
        ),
      ),
      values(),
      flat(),
    ),
  )

  const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

  const decorateModel = (model: ReturnType<typeof available>[number]) => ({
    ...model,
    name: model.name.replace("(latest)", "").trim(),
    latest: model.name.includes("(latest)"),
  })

  const list = createMemo(() => available().map(decorateModel))

  const find = (key: ModelKey) => {
    const visibleModel = list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)
    if (visibleModel) return visibleModel

    const hit = findProviderModel(providers.connected(), key)
    if (!hit) return
    const provider = providers.connected().find((item) => item.id === key.providerID)
    if (!provider) return
    return decorateModel({ ...hit, provider })
  }

  const visible = (model: ModelKey) => {
    const key = modelKey(model)
    const state = visibility().get(key)
    if (state === "hide") return false
    if (state === "show") return true
    if (latestSet().has(key)) return true
    const date = release().get(key)
    if (!date?.isValid) return true
    return false
  }

  return { list, find, visible }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const view = createModelsView(providers, visibility)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list: view.list,
      find: view.find,
      visible: view.visible,
      visibility,
      setVisibility,
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})

// Models scoped to a chosen directory rather than the current route. The
// Automations create card files an automation against any open project, so its
// model list, default and validation must follow the selected folder — not the
// routed one — or it would offer/seed a model the target project can't run
// (#950 PR7). Shares the global user prefs (visibility, recent, variant) since
// those are per-user, not per-project.
export function useScopedModels(dir: Accessor<string | undefined>) {
  const global = useModels()
  const providers = useProviders(dir)
  const view = createModelsView(providers, global.visibility)
  return { ...global, list: view.list, find: view.find, visible: view.visible }
}
