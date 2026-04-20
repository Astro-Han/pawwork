import type { Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "./settings-general"
import { SettingsKeybinds } from "./settings-keybinds"
import { SettingsModels } from "./settings-models"
import { SettingsProviders } from "./settings-providers"

export type SettingsPageTab = "general" | "shortcuts" | "providers" | "models"

export const SettingsPage: Component<{
  active: SettingsPageTab
  onSelect: (value: SettingsPageTab) => void
  onClose: () => void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <section data-component="settings-page" class="flex size-full min-h-0 bg-background-base">
      <Tabs
        orientation="vertical"
        variant="settings"
        value={props.active}
        onChange={(value) => value && props.onSelect(value as SettingsPageTab)}
        class="h-full w-full"
      >
        <Tabs.List>
          <div class="flex h-full w-full flex-col justify-between">
            <div class="flex w-full flex-col gap-3 pt-3">
              <div class="flex items-center justify-between px-1">
                <h1 class="text-18-medium text-text-strong">{language.t("sidebar.settings")}</h1>
                <Button
                  data-action="settings-page-close"
                  variant="ghost"
                  size="small"
                  icon="close"
                  onClick={props.onClose}
                  aria-label={language.t("common.close")}
                >
                  {language.t("common.close")}
                </Button>
              </div>

              <div class="flex flex-col gap-3 w-full">
                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </Tabs.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <Tabs.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </Tabs.Trigger>
                    <Tabs.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </Tabs.Trigger>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-11-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <SettingsGeneral />
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <SettingsKeybinds />
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <SettingsProviders />
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <SettingsModels />
        </Tabs.Content>
      </Tabs>
    </section>
  )
}
