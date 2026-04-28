import { type Component, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}
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
  let root: HTMLElement | undefined
  let returnFocus: HTMLElement | undefined

  onMount(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !root?.contains(active)) returnFocus = active
    if (!root) return
    const [first] = focusablesIn(root)
    first?.focus()
  })

  onCleanup(() => {
    const target = returnFocus
    returnFocus = undefined
    if (!target || !target.isConnected) return
    target.focus()
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !root) return

    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose()
      return
    }

    if (event.key !== "Tab") return
    const focusables = focusablesIn(root)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = !!active && root.contains(active)

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section
      ref={(el) => (root = el)}
      data-component="settings-page"
      class="flex size-full min-h-0 bg-background-base"
      onKeyDown={handleKeyDown}
    >
      <Tabs
        orientation="vertical"
        variant="settings"
        value={props.active}
        onChange={(value) => {
          if (value !== "general" && value !== "shortcuts" && value !== "providers" && value !== "models") return
          props.onSelect(value)
        }}
        class="h-full w-full"
      >
        <Tabs.List>
          <div class="flex h-full w-full flex-col justify-between">
            <div class="flex w-full flex-col gap-3 pt-3">
              <div class="flex items-center justify-between px-1">
                <h1 class="text-16-medium text-text-strong">{language.t("sidebar.settings")}</h1>
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

            <div class="flex flex-col gap-1 pl-1 py-1 text-13-medium text-text-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-13-regular">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content value="general" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsGeneral />
          </div>
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsKeybinds />
          </div>
        </Tabs.Content>
        <Tabs.Content value="providers" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsProviders />
          </div>
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsModels />
          </div>
        </Tabs.Content>
      </Tabs>
    </section>
  )
}
