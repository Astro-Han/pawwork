import { For, Show, createMemo, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import {
  HOME_SUGGESTION_CHIPS,
  resolveVisibleHomeSuggestions,
  type HomeSuggestionChipID,
} from "./home-suggestions-state"

const PROMPT_EDITOR_SELECTOR = '[data-component="prompt-input"]'

function focusComposerEditor() {
  if (typeof document === "undefined") return
  const editor = document.querySelector<HTMLElement>(PROMPT_EDITOR_SELECTOR)
  editor?.focus()
}

export const HomeSuggestionList: Component = () => {
  const language = useLanguage()
  const prompt = usePrompt()
  const settings = useSettings()
  const sync = useSync()

  const sessionCount = createMemo(() => Object.keys(sync.data.session ?? {}).length)
  // sync.ready guards against showing chips during the initial loading hydration —
  // sync.data.session is an empty object while status === "loading", which would
  // make every user (returning or new) momentarily look like a first-time visitor.
  // sync.ready is a getter on the context (not a function).
  const firstTimeVisitor = createMemo(() => sync.ready && sessionCount() === 0)

  const visibleIDs = createMemo(() =>
    resolveVisibleHomeSuggestions({
      firstTimeVisitor: firstTimeVisitor(),
      enabled: settings.general.homeSuggestionsEnabled(),
      dismissed: settings.general.homeSuggestionsDismissed() as HomeSuggestionChipID[],
    }),
  )

  const visibleChips = createMemo(() => {
    const ids = new Set(visibleIDs())
    return HOME_SUGGESTION_CHIPS.filter((chip) => ids.has(chip.id))
  })

  type I18nKey = Parameters<typeof language.t>[0]

  const prefill = (text: string) => {
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(focusComposerEditor)
  }

  const dismissRow = (id: HomeSuggestionChipID) => {
    const current = settings.general.homeSuggestionsDismissed() as HomeSuggestionChipID[]
    if (current.includes(id)) return
    settings.general.setHomeSuggestionsDismissed([...current, id])
  }

  const dismissAll = () => {
    settings.general.setHomeSuggestionsDismissed(HOME_SUGGESTION_CHIPS.map((chip) => chip.id))
  }

  return (
    <Show when={visibleChips().length > 0}>
      <section
        data-component="home-suggestion-list"
        class="mx-auto mt-6 flex w-full max-w-[640px] flex-col gap-1"
      >
        <header class="flex items-center justify-between px-1 text-fg-muted text-sm">
          <div class="flex items-center gap-3 flex-1">
            <span>{language.t("home.suggestion.section.label")}</span>
            <div class="flex-1 border-t border-border-subtle" />
          </div>
          <button
            type="button"
            class="ml-3 text-fg-muted hover:text-fg-strong"
            aria-label={language.t("home.suggestion.section.dismiss")}
            onClick={dismissAll}
            data-action="home-suggestion-section-dismiss"
          >
            <Icon name="close" class="size-4" />
          </button>
        </header>
        <ul class="flex flex-col">
          <For each={visibleChips()}>
            {(chip) => (
              <li class="group flex items-center justify-between px-1 py-2 hover:bg-row-hover-overlay">
                <button
                  type="button"
                  class="flex-1 text-left text-fg-base hover:text-fg-strong"
                  onClick={() => prefill(language.t(chip.i18nKey as I18nKey))}
                  data-action="home-suggestion-row"
                  data-chip-id={chip.id}
                >
                  {language.t(chip.i18nKey as I18nKey)}
                </button>
                <button
                  type="button"
                  class="ml-3 text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg-strong transition-opacity"
                  aria-label={language.t("home.suggestion.row.dismiss")}
                  onClick={() => dismissRow(chip.id)}
                  data-action="home-suggestion-row-dismiss"
                  data-chip-id={chip.id}
                >
                  <Icon name="close" class="size-4" />
                </button>
              </li>
            )}
          </For>
        </ul>
      </section>
    </Show>
  )
}
