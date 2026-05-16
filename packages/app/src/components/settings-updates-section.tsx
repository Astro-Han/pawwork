import { type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { canCheckUpdate, usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsRow } from "./settings-row"

export const SettingsUpdatesSection: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const [store, setStore] = createStore({
    checking: false,
  })

  const check = () => {
    const checkUpdate = platform.checkUpdate
    if (!canCheckUpdate(platform) || !checkUpdate) return
    setStore("checking", true)

    void checkUpdate()
      .then((result) => {
        if (result.status === "busy") {
          showToast({
            title: language.t("settings.updates.toast.busy.title"),
            description: language.t("settings.updates.toast.busy.description"),
          })
          return
        }

        if (result.status === "disabled") {
          showToast({
            title: language.t("settings.updates.toast.disabled.title"),
            description: language.t("settings.updates.toast.disabled.description"),
          })
          return
        }

        if (result.status === "failed") {
          showToast({
            title: language.t("common.requestFailed"),
            description: result.message || language.t("settings.updates.toast.failed.description"),
          })
          return
        }

        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions = platform.update
          ? [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  await platform.update!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]
          : [
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  return (
    <div class="flex flex-col gap-1">
      <h3 class="text-h3 text-fg-strong pb-2">{language.t("settings.general.section.updates")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.updates.row.startup.title")}
          description={language.t("settings.updates.row.startup.description")}
        >
          <div data-action="settings-updates-startup">
            <Switch
              checked={settings.updates.startup()}
              disabled={!canCheckUpdate(platform)}
              onChange={(checked) => settings.updates.setStartup(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.general.row.releaseNotes.title")}
          description={language.t("settings.general.row.releaseNotes.description")}
        >
          <div data-action="settings-release-notes">
            <Switch
              checked={settings.general.releaseNotes()}
              onChange={(checked) => settings.general.setReleaseNotes(checked)}
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title={language.t("settings.updates.row.check.title")}
          description={language.t("settings.updates.row.check.description")}
        >
          <Button variant="secondary" disabled={store.checking || !canCheckUpdate(platform)} onClick={check}>
            {store.checking
              ? language.t("settings.updates.action.checking")
              : language.t("settings.updates.action.checkNow")}
          </Button>
        </SettingsRow>
      </SettingsList>
    </div>
  )
}
