import { createMemo, createResource, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { DialogConnectWebSearch } from "./dialog-connect-websearch"
import { SettingsRow } from "./settings-row"

export const SettingsWebSearchRow: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()

  const [webSearchStatusResource, webSearchStatusActions] = createResource(() => window.api?.webSearchStatus?.())
  const webSearchStatus = createMemo(() => webSearchStatusResource.latest)
  const webSearchChipText = createMemo(() => {
    const status = webSearchStatus()
    if (!status) return language.t("settings.general.webSearch.chip.loading")
    if (status.source === "saved" && status.quotaExceeded) return language.t("settings.general.webSearch.chip.savedQuota")
    if (status.source === "saved" && status.needsAttention) return language.t("settings.general.webSearch.chip.invalid")
    if (status.source === "saved") return language.t("settings.general.webSearch.chip.personal")
    if (status.source === "env") return language.t("settings.general.webSearch.chip.env")
    if (status.quotaExceeded) return language.t("settings.general.webSearch.chip.exhausted")
    return language.t("settings.general.webSearch.chip.free")
  })

  return (
    <SettingsRow
      title={
        <div class="flex items-center gap-2">
          <span>{language.t("settings.general.webSearch.title")}</span>
          <span class="text-body text-fg-weaker rounded px-1.5 py-0.5 bg-bg-cream">{webSearchChipText()}</span>
        </div>
      }
      description={
        <>
          <span>{language.t("settings.general.webSearch.description")}</span>
          {webSearchStatus()?.source === "saved" && webSearchStatus()?.quotaExceeded && (
            <span class="block pt-1 text-body text-fg-weaker">
              {language.t("settings.general.webSearch.secondary.savedQuota")}
            </span>
          )}
          {webSearchStatus()?.source === "saved" && webSearchStatus()?.needsAttention && (
            <span class="block pt-1 text-body text-fg-weaker">
              {language.t("settings.general.webSearch.secondary.failed")}
            </span>
          )}
          {webSearchStatus()?.source === "anonymous" && webSearchStatus()?.quotaExceeded && (
            <span class="block pt-1 text-body text-fg-weaker">
              {language.t("settings.general.webSearch.secondary.exhausted")}
            </span>
          )}
        </>
      }
    >
      <div class="flex items-center gap-2">
        <Button
          data-action="settings-web-search-manage"
          size="small"
          variant="ghost"
          onClick={() => dialog.show(() => <DialogConnectWebSearch onStatusChanged={webSearchStatusActions.refetch} />)}
        >
          {language.t("settings.general.webSearch.action.manage")}
        </Button>
        <div data-action="settings-web-search-enabled">
          <Switch
            checked={settings.general.webSearchEnabled()}
            onChange={(checked) => settings.general.setWebSearchEnabled(checked)}
          />
        </div>
      </div>
    </SettingsRow>
  )
}
