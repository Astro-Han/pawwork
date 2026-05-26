import { type Component } from "solid-js"
import { Select } from "@opencode-ai/ui/select"
import { useLanguage } from "@/context/language"
import { useSettings, type NotifyLevel } from "@/context/settings"
import { SettingsList } from "./settings-list"
import { SettingsRow } from "./settings-row"

const notifyOptions = [
  { id: "never" as NotifyLevel, label: "settings.notify.option.never" },
  { id: "unfocused" as NotifyLevel, label: "settings.notify.option.unfocused" },
  { id: "always" as NotifyLevel, label: "settings.notify.option.always" },
]

export const SettingsNotifySection: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <div class="flex flex-col gap-1">
      <h3 class="text-h3 text-fg-strong pb-2">{language.t("settings.general.section.notify")}</h3>

      <SettingsList>
        <SettingsRow
          title={language.t("settings.notify.title")}
          description={language.t("settings.notify.description")}
        >
          <Select
            data-action="settings-notify-level"
            options={notifyOptions}
            current={notifyOptions.find((o) => o.id === settings.notify.level()) ?? notifyOptions[1]}
            value={(o) => o.id}
            label={(o) => language.t(o.label)}
            onSelect={(option) => {
              if (!option) return
              settings.notify.setLevel(option.id)
            }}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </SettingsRow>
      </SettingsList>
    </div>
  )
}
