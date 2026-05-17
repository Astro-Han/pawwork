import { For, Show, createEffect, createMemo, createSignal, type Component } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
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

  // sessionCount is observed only for the auto-dismiss side effect below —
  // it does NOT gate visibility. Chips are pure capability discovery: shown
  // until each is individually dismissed, regardless of current workspace.
  const sessionCount = createMemo(() => sync.data.session?.length ?? 0)

  const visibleIDs = createMemo(() => {
    // Wait for BOTH stores. On desktop, sync and settings are separate async
    // hydrations (see packages/app/src/utils/persist.ts AsyncStorage branch),
    // so sync.ready alone does not imply settings.ready(). The dismissed
    // accessor uses a withFallback([]) default, which would briefly read as
    // an empty list and re-show chips the user has already dismissed.
    if (!sync.ready || !settings.ready()) return []
    return resolveVisibleHomeSuggestions({
      dismissed: filterKnownIDs(settings.general.homeSuggestionsDismissed()),
    })
  })

  const visibleChips = createMemo(() => {
    const ids = new Set(visibleIDs())
    return HOME_SUGGESTION_CHIPS.filter((chip) => ids.has(chip.id))
  })

  type I18nKey = Parameters<typeof language.t>[0]

  // ─── Chip lifecycle state machine (see spec § Chip Lifecycle) ───
  // currentChipSource tracks "the chip this composer content came from."
  //   null  → no chip has been clicked yet on this mount
  //   X     → composer was last prefilled by chip X (sticks through user edits
  //           and clears; replaced when another chip is clicked)
  // Transitions:
  //   chip X click           → setSource(X)
  //   chip Y click after X   → setSource(Y)
  //   user edits / clears    → no change (sticky)
  // Side effect: when sessionCount transitions upward with source set, the chip
  // graduated into a real task — dismiss it globally so capability discovery
  // doesn't re-pitch it on the next visit or workspace.
  //
  // The previous "drain composer also clears source" branch was removed because
  // it forced the effect to subscribe to prompt.dirty(), which emits on every
  // keystroke. On the home cold path that turned the effect into a hot loop
  // visible in perf-probe-baseline (frame_gap_max jump). The only behavior
  // difference: a user who clicks a chip, then types their own thing and sends,
  // now sees that chip dismissed too — acceptable since they engaged with it.
  // ────────────────────────────────────────────────────────────────
  const [currentChipSource, setCurrentChipSource] = createSignal<HomeSuggestionChipID | null>(null)

  const dismissRow = (id: HomeSuggestionChipID) => {
    const current = filterKnownIDs(settings.general.homeSuggestionsDismissed())
    if (current.includes(id)) return
    settings.general.setHomeSuggestionsDismissed([...current, id])
  }

  createEffect<number | undefined>((prev) => {
    const count = sessionCount()
    if (prev !== undefined && count > prev) {
      const source = currentChipSource()
      if (source) dismissRow(source)
      setCurrentChipSource(null)
    }
    return count
  }, undefined)

  const prefill = (chipID: HomeSuggestionChipID, text: string) => {
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    setCurrentChipSource(chipID)
    requestAnimationFrame(() => focusComposerEditor(text.length))
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
                  onClick={() => prefill(chip.id, language.t(chip.promptKey as I18nKey))}
                  data-action="home-suggestion-row"
                  data-chip-id={chip.id}
                >
                  {language.t(chip.labelKey as I18nKey)}
                </button>
                <button
                  type="button"
                  // 30×30 ghost icon button per DESIGN.md L334: hover overlay is
                  // --row-active-overlay (6%), "one tier deeper than the row to
                  // read separately" (DESIGN.md L401, session-row action).
                  // Keyboard-reachable via Tab so a keyboard-only user can
                  // dismiss a chip without a pointer; visually hidden at rest
                  // and revealed only when the row is hovered or anything inside
                  // the row has focus.
                  class="-mr-1 flex size-[30px] shrink-0 items-center justify-center rounded-md text-fg-weak opacity-0 pointer-events-none transition-opacity hover:bg-row-active-overlay hover:text-fg-strong focus-visible:opacity-100 focus-visible:pointer-events-auto group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto"
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
