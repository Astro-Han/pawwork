import { type Component, For, Match, Switch, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "@/components/settings-general"
import { SettingsKeybinds } from "@/components/settings-keybinds"
import { SettingsMemory } from "@/components/settings-memory"
import { SettingsWorktrees } from "@/components/settings-worktrees"
import { ModelsPage } from "./models"

// Settings renders as a shell-slot takeover: the nav goes into the sidebar slot
// (SettingsNav) and the page into the main slot (SettingsContent). Geometry
// (width / background / border) is inherited from the shell slots instead of being
// re-declared, which removes the alignment drift the old standalone overlay had
// (its fixed 200px nav + surface-raised content diverged from the real sidebar).
// Remote access / Integrations are not part of this surface yet: their pages have no content
// branch, so they are intentionally absent from both the type and TAB_VALUES. They come back —
// type, TAB_VALUES, NAV_ITEMS and a content Match together — when their pages land. The
// connection management they will host is still reachable via right-panel Connections.
export type SettingsTab = "general" | "shortcuts" | "models" | "worktrees" | "memory"

const TAB_VALUES: SettingsTab[] = ["general", "shortcuts", "models", "worktrees", "memory"]

export function isSettingsTab(value: string): value is SettingsTab {
  return (TAB_VALUES as string[]).includes(value)
}

const NAV_ITEMS = [
  { value: "general", icon: "settings-gear", labelKey: "settings.tab.general" },
  { value: "shortcuts", icon: "keyboard", labelKey: "settings.tab.shortcuts" },
  { value: "models", icon: "models", labelKey: "settings.tab.models" },
  { value: "worktrees", icon: "worktree", labelKey: "settings.tab.worktrees" },
  { value: "memory", icon: "brain", labelKey: "settings.tab.memory" },
] as const satisfies ReadonlyArray<{ value: SettingsTab; icon: string; labelKey: string }>

// Settings nav: fills the sidebar slot as a flat tablist (back-to-app + tabs + version footer).
// Tab roles/keyboard are hand-rolled (role=tab/tablist + arrow roving) because the nav and the
// content live in two separate shell slots and cannot share a single Kobalte Tabs root.
export const SettingsNav: Component<{
  active: SettingsTab
  onSelect: (value: SettingsTab) => void
  onClose: () => void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  let listRef: HTMLDivElement | undefined

  const focusTab = (value: SettingsTab) => {
    props.onSelect(value)
    listRef?.querySelector<HTMLElement>(`[data-tab="${value}"]`)?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const index = NAV_ITEMS.findIndex((item) => item.value === props.active)
    if (index === -1) return
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        focusTab(NAV_ITEMS[(index + 1) % NAV_ITEMS.length].value)
        break
      case "ArrowUp":
        event.preventDefault()
        focusTab(NAV_ITEMS[(index - 1 + NAV_ITEMS.length) % NAV_ITEMS.length].value)
        break
      case "Home":
        event.preventDefault()
        focusTab(NAV_ITEMS[0].value)
        break
      case "End":
        event.preventDefault()
        focusTab(NAV_ITEMS[NAV_ITEMS.length - 1].value)
        break
    }
  }

  return (
    <nav
      data-component="settings-nav"
      aria-label={language.t("sidebar.settings")}
      class="flex size-full flex-col justify-between bg-sidebar p-3"
    >
      <div class="flex w-full flex-col gap-1.5">
        <Button
          data-action="settings-back"
          variant="ghost"
          size="small"
          icon="arrow-left"
          onClick={props.onClose}
          class="w-full justify-start"
          aria-label={language.t("settings.backToApp")}
        >
          {language.t("settings.backToApp")}
        </Button>
        <div class="my-1 h-px bg-border-weaker" />
        <div
          ref={(el) => (listRef = el)}
          role="tablist"
          aria-orientation="vertical"
          aria-label={language.t("sidebar.settings")}
          class="flex w-full flex-col gap-0.5"
          onKeyDown={onKeyDown}
        >
          <For each={NAV_ITEMS}>
            {(item) => {
              const selected = () => props.active === item.value
              return (
                <button
                  type="button"
                  role="tab"
                  data-tab={item.value}
                  data-action={`settings-tab-${item.value}`}
                  aria-selected={selected()}
                  aria-controls="settings-panel"
                  tabindex={selected() ? 0 : -1}
                  onClick={() => props.onSelect(item.value)}
                  class="flex h-[30px] w-full items-center gap-3 rounded-md px-2 text-h3 transition-colors"
                  classList={{
                    "bg-row-active-overlay text-fg-strong": selected(),
                    "text-fg-base hover:bg-row-hover-overlay": !selected(),
                  }}
                >
                  <Icon name={item.icon} class={selected() ? "text-icon-strong" : "text-icon-base"} />
                  {language.t(item.labelKey)}
                </button>
              )
            }}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-1 px-1 py-1 text-h3 text-fg-weak">
        <span>{language.t("app.name.desktop")}</span>
        <span class="text-body">v{platform.version}</span>
      </div>
    </nav>
  )
}

// Settings content: fills the main slot and swaps page by active tab. Mounting equals
// entering settings, so it owns Escape-to-close and focus save/restore.
export const SettingsContent: Component<{
  active: SettingsTab
  directory?: string
  onClose: () => void
}> = (props) => {
  const language = useLanguage()

  onMount(() => {
    // Entering settings: move focus to the selected tab (or the back button); restore
    // focus to whatever was focused before on exit.
    const previous = document.activeElement as HTMLElement | null
    const target =
      document.querySelector<HTMLElement>('[data-component="settings-nav"] [aria-selected="true"]') ??
      document.querySelector<HTMLElement>('[data-action="settings-back"]')
    target?.focus()

    // Escape closes settings via a document capture listener, ahead of the global keybind
    // that would otherwise consume Escape. Because capture runs before the popover's own
    // bubble-phase Escape handler, bail while a transient overlay is open so it can consume
    // Escape first: a dialog (e.g. connecting a provider) or an open Select dropdown. Both
    // mount their layer only while open. Any future portalled popover in settings must be
    // added here, or Escape will tear down the whole shell instead of closing the popover.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (document.querySelector('[data-component="dialog-overlay"], [data-component="select-content"]')) return
      event.preventDefault()
      props.onClose()
    }
    document.addEventListener("keydown", onEscape, true)

    onCleanup(() => {
      document.removeEventListener("keydown", onEscape, true)
      if (previous?.isConnected) previous.focus()
    })
  })

  return (
    <section
      data-component="settings-page"
      aria-label={language.t("sidebar.settings")}
      class="no-scrollbar size-full overflow-y-auto bg-bg-base"
    >
      <div role="tabpanel" id="settings-panel" class="mx-auto w-full max-w-[760px]">
        <Switch>
          <Match when={props.active === "general"}>
            <SettingsGeneral />
          </Match>
          <Match when={props.active === "shortcuts"}>
            <SettingsKeybinds />
          </Match>
          <Match when={props.active === "models"}>
            <ModelsPage />
          </Match>
          <Match when={props.active === "worktrees"}>
            <SettingsWorktrees />
          </Match>
          <Match when={props.active === "memory"}>
            <SettingsMemory directory={props.directory} />
          </Match>
        </Switch>
      </div>
    </section>
  )
}
