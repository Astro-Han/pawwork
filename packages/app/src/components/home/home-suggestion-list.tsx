import { For, Show, createEffect, createMemo, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import {
  HOME_SUGGESTION_CHIPS,
  resolveVisibleHomeSuggestions,
  type HomeSuggestionChipID,
} from "./home-suggestions-state"

const PROMPT_EDITOR_SELECTOR = '[data-component="prompt-input"]'

function focusComposerEditor(caretAt: number) {
  if (typeof document === "undefined") return
  const editor = document.querySelector<HTMLElement>(PROMPT_EDITOR_SELECTOR)
  if (!editor) return
  editor.focus()
  setCursorPosition(editor, caretAt)
}

const KNOWN_CHIP_IDS = new Set<HomeSuggestionChipID>(HOME_SUGGESTION_CHIPS.map((chip) => chip.id))

function filterKnownIDs(raw: readonly string[]): HomeSuggestionChipID[] {
  const out: HomeSuggestionChipID[] = []
  for (const value of raw) {
    if (KNOWN_CHIP_IDS.has(value as HomeSuggestionChipID)) {
      out.push(value as HomeSuggestionChipID)
    }
  }
  return out
}

export const HomeSuggestionList: Component = () => {
  const language = useLanguage()
  const prompt = usePrompt()
  const settings = useSettings()
  const sync = useSync()

  const sessionCount = createMemo(() => sync.data.session?.length ?? 0)
  const seen = createMemo(() => settings.general.homeSuggestionsSeen())

  // Flip seen=true on first hydrated state with sessions. Returning users
  // who clean up all sessions will never re-enter first-time onboarding.
  createEffect(() => {
    if (!sync.ready) return
    if (seen()) return
    if (sessionCount() > 0) settings.general.setHomeSuggestionsSeen(true)
  })

  // sync.ready guards against showing chips during initial hydration, where
  // sync.data.session is briefly empty and every user looks like a new visitor.
  // sync.ready is a reactive getter on the context, not a function call.
  const firstTimeVisitor = createMemo(() => sync.ready && sessionCount() === 0 && !seen())

  const visibleIDs = createMemo(() =>
    resolveVisibleHomeSuggestions({
      firstTimeVisitor: firstTimeVisitor(),
      enabled: settings.general.homeSuggestionsEnabled(),
      dismissed: filterKnownIDs(settings.general.homeSuggestionsDismissed()),
    }),
  )

  const visibleChips = createMemo(() => {
    const ids = new Set(visibleIDs())
    return HOME_SUGGESTION_CHIPS.filter((chip) => ids.has(chip.id))
  })

  type I18nKey = Parameters<typeof language.t>[0]

  const markSeen = () => {
    if (!seen()) settings.general.setHomeSuggestionsSeen(true)
  }

  const prefill = (text: string) => {
    // If the user has already started typing (or @-mentioned a file), do not
    // overwrite their work. Just focus the editor and leave the composer
    // untouched. They can clear it and click the chip again if they really
    // want the suggestion. Naively merging would lose non-text parts like
    // file/agent mentions, which is a worse failure mode than no-op here.
    // We also do NOT mark seen in this no-op path: the user hasn't actually
    // engaged with onboarding, so flipping seen would silently exit them.
    if (prompt.dirty()) {
      requestAnimationFrame(() => focusComposerEditor(promptLength(prompt.current())))
      return
    }
    markSeen()
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(() => focusComposerEditor(text.length))
  }

  const dismissRow = (id: HomeSuggestionChipID) => {
    // Per-row dismiss is fine-grained curation, not an onboarding exit signal.
    // Do NOT mark seen here, or the section hides immediately after the first
    // dismiss and the Settings restore button becomes a silent no-op.
    const current = filterKnownIDs(settings.general.homeSuggestionsDismissed())
    if (current.includes(id)) return
    settings.general.setHomeSuggestionsDismissed([...current, id])
  }

  const dismissAll = () => {
    markSeen()
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
                  tabIndex={-1}
                  class="ml-3 text-fg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto hover:text-fg-strong transition-opacity"
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
