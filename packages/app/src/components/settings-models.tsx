import { Button } from "@opencode-ai/ui/button"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { type Component, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { clientActionHeaders } from "@/utils/server"
import { mergeFetchedModels } from "./settings-models-fetch"
import { SettingsList } from "./settings-list"
import { compareModelsForDisplay } from "@/utils/model-order"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

// Only OpenAI-compatible providers (custom providers + gateways like Kilo) expose a /models endpoint
// we can discover from. Native SDKs (anthropic, etc.) do not, so the action stays hidden for them.
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

const ListLoadingState: Component<{ label: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-body text-fg-weak">{props.label}</span>
    </div>
  )
}

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-body text-fg-weak">{props.message}</span>
      <Show when={props.filter}>
        <span class="text-body text-fg-strong mt-1">&quot;{props.filter}&quot;</span>
      </Show>
    </div>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [fetchingID, setFetchingID] = createSignal<string>()

  // Live-fetch the provider's models and persist any the catalog/config does not already list. New models
  // land disabled (visibility default), so a 300-model gateway never floods the picker. Issue #1463.
  const fetchModels = async (provider: ModelItem["provider"]) => {
    if (fetchingID()) return
    setFetchingID(provider.id)
    try {
      const actionClient = globalSDK.createClient({
        headers: clientActionHeaders({ kind: "settings.models.fetch" }),
        throwOnError: true,
      })
      const response = await actionClient.provider.fetchModels({ providerID: provider.id })
      const configProvider = globalSync.data.config.provider?.[provider.id]
      const { models: nextModels, addedModelIDs, skipped } = mergeFetchedModels({
        existingModelIDs: Object.keys(provider.models),
        configModels: configProvider?.models,
        fetched: response.data?.models ?? [],
      })
      if (addedModelIDs.length === 0) {
        showToast({
          title: language.t("provider.fetchModels.toast.none.title"),
          description: language.t("provider.fetchModels.toast.none.description", { provider: provider.name }),
        })
        return
      }
      // Mark new models hidden before they enter the catalog: they carry no release_date, and the model
      // visibility default treats undated models as visible — so without this a large gateway would flood
      // the picker. The user toggles on the ones they want. Issue #1463.
      for (const modelID of addedModelIDs) models.setVisibility({ providerID: provider.id, modelID }, false)
      await globalSync.updateConfig({ provider: { [provider.id]: { ...configProvider, models: nextModels } } })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.fetchModels.toast.added.title"),
        description: language.t("provider.fetchModels.toast.added.description", {
          added: addedModelIDs.length,
          skipped,
        }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      setFetchingID(undefined)
    }
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: compareModelsForDisplay,
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--bg-base)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <h2 class="text-h2 text-fg-strong">{language.t("settings.models.title")}</h2>
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={list.filter()}
              onChange={list.onInput}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={list.filter()}>
              <IconButton icon="circle-x" onClick={list.clear} aria-label="Clear filter" />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!list.grouped.loading}
          fallback={
            <ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={<ListEmptyState message={language.t("dialog.model.empty")} filter={list.filter()} />}
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div class="flex items-center gap-2 pb-2">
                    <ProviderIcon id={group.category} class="size-5 shrink-0 text-icon-strong" />
                    <span class="text-h3 text-fg-strong">{group.items[0].provider.name}</span>
                    <Show when={group.items.some((item) => item.api?.npm === OPENAI_COMPATIBLE)}>
                      <Button
                        type="button"
                        variant="ghost"
                        icon="refresh"
                        class="ml-auto"
                        disabled={Boolean(fetchingID())}
                        onClick={() => void fetchModels(group.items[0].provider)}
                      >
                        {fetchingID() === group.items[0].provider.id
                          ? language.t("provider.fetchModels.loading")
                          : language.t("provider.fetchModels.action")}
                      </Button>
                    </Show>
                  </div>
                  <SettingsList>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        return (
                          <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak last:border-none">
                            <div class="min-w-0">
                              <span class="text-body text-fg-strong truncate block">{item.name}</span>
                            </div>
                            <div class="flex-shrink-0">
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </div>
                        )
                      }}
                    </For>
                  </SettingsList>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
