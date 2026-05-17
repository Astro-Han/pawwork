import { For, Show, createMemo, type Component } from "solid-js"
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
  // sync.ready guards the brief hydration window where session is empty and
  // every user looks new. sync.ready is a reactive getter on the context.
  const firstTimeVisitor = createMemo(() => sync.ready && sessionCount() === 0)

  const visibleIDs = createMemo(() =>
    resolveVisibleHomeSuggestions({
      firstTimeVisitor: firstTimeVisitor(),
      dismissed: filterKnownIDs(settings.general.homeSuggestionsDismissed()),
    }),
  )

  const visibleChips = createMemo(() => {
    const ids = new Set(visibleIDs())
    return HOME_SUGGESTION_CHIPS.filter((chip) => ids.has(chip.id))
  })

  type I18nKey = Parameters<typeof language.t>[0]

  const prefill = (text: string) => {
    // Dirty composer: do not overwrite user-typed content (including @-mentions).
    // Just focus the editor and leave it alone.
    if (prompt.dirty()) {
      requestAnimationFrame(() => focusComposerEditor(promptLength(prompt.current())))
      return
    }
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(() => focusComposerEditor(text.length))
  }

  const dismissRow = (id: HomeSuggestionChipID) => {
    const current = filterKnownIDs(settings.general.homeSuggestionsDismissed())
    if (current.includes(id)) return
    settings.general.setHomeSuggestionsDismissed([...current, id])
  }

  return (
    <Show when={visibleChips().length > 0}>
      <section
        data-component="home-suggestion-list"
        // Composer is max-w-[640px] with 1px border + 16px inner padding, so
        // its text frame starts 17px inside the container. Inset 16px on each
        // side (640 - 32 = 608) so row hover-overlay lands inside the composer's
        // visible text frame instead of overshooting it.
        class="mx-auto mt-6 flex w-full max-w-[608px] flex-col"
      >
        <ul class="flex flex-col gap-1">
          <For each={visibleChips()}>
            {(chip) => (
              <li class="group flex h-[30px] items-center gap-2 rounded-sm px-2 transition-colors hover:bg-row-hover-overlay focus-within:bg-row-hover-overlay">
                <button
                  type="button"
                  class="flex h-full flex-1 items-center text-left text-fg-weak transition-colors group-hover:text-fg-strong group-focus-within:text-fg-strong focus:outline-none"
                  onClick={() => prefill(language.t(chip.promptKey as I18nKey))}
                  data-action="home-suggestion-row"
                  data-chip-id={chip.id}
                >
                  {language.t(chip.labelKey as I18nKey)}
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  // 30×30 ghost icon button per DESIGN.md L334: hover overlay is
                  // --row-active-overlay (6%), "one tier deeper than the row to
                  // read separately" (DESIGN.md L401, session-row action).
                  class="-mr-1 flex size-[30px] shrink-0 items-center justify-center rounded-md text-fg-weak opacity-0 pointer-events-none transition-opacity hover:bg-row-active-overlay hover:text-fg-strong group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
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
