import {
  type Accessor,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { SkillDetail } from "./skill-detail"
import { skillMatches, skillSummary, skillTitle, type SkillInfo } from "./skill-presentation"

// One capability row: cream tile + brand glyph, humanized title, one-line
// (clamped) description. Borderless; the hover tint is the only affordance.
function SkillRow(props: { skill: SkillInfo; onOpen: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-action="skill-open"
      data-skill={props.skill.name}
      onClick={props.onOpen}
      class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left hover:bg-row-hover-overlay focus:outline-none focus-visible:bg-row-hover-overlay"
    >
      <span class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-interactive-base">
        <Icon name="skill" class="size-[18px] text-brand-primary" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-body text-fg-strong">{skillTitle(props.skill.name)}</span>
        <Show when={skillSummary(props.skill)}>
          {(summary) => <span class="mt-0.5 block truncate text-caption text-fg-weak">{summary()}</span>}
        </Show>
      </span>
    </button>
  )
}

export function SkillsSurface(props: {
  directory: Accessor<string>
  onClose: () => void
  onUseSkill: (name: string) => void
}): JSX.Element {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<SkillInfo | undefined>()

  const [skills] = createResource(
    () => props.directory(),
    async (directory) => {
      const res = await globalSDK.client.app.skills({ directory })
      return (res.data ?? []).slice().sort((a, b) => skillTitle(a.name).localeCompare(skillTitle(b.name)))
    },
  )

  const filtered = createMemo(() => {
    const all = skills() ?? []
    const needle = query()
    return needle ? all.filter((skill) => skillMatches(skill, needle)) : all
  })

  // While the resource is still resolving its first batch, `skills()` is
  // undefined and `filtered()` is empty — rendering the empty-state copy then
  // would flash "no skills" on every normal load and mislabel a load failure as
  // "no skills". Key the body off the resource state so the empty copy only
  // shows once we actually have a (filtered-to-zero) result, and load failures
  // get their own message.
  const view = createMemo<"loading" | "error" | "empty" | "list">(() => {
    if (skills.state === "errored") return "error"
    if (skills.state === "pending" || skills.state === "unresolved") return "loading"
    return filtered().length > 0 ? "list" : "empty"
  })

  // Escape closes the open detail first, then the surface. The sidebar stays
  // live behind this surface, so transient overlays get Escape ahead of us.
  onMount(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (
        document.querySelector(
          '[data-component="dialog-overlay"], [data-component="select-content"], [data-component="dropdown-menu-content"], [data-component="context-menu-content"]',
        )
      )
        return
      event.preventDefault()
      if (selected()) {
        setSelected(undefined)
        return
      }
      props.onClose()
    }
    document.addEventListener("keydown", onEscape, true)
    onCleanup(() => document.removeEventListener("keydown", onEscape, true))
  })

  return (
    <section
      data-component="skills-page"
      aria-label={language.t("skills.title")}
      class="no-scrollbar size-full overflow-y-auto bg-bg-base"
    >
      <div class="mx-auto w-full max-w-[760px] px-6 py-6">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <h1 class="text-h2 text-fg-strong">{language.t("skills.title")}</h1>
            <p class="mt-1 text-body text-fg-weak">{language.t("skills.subtitle")}</p>
          </div>
          <label class="flex h-9 w-56 shrink-0 items-center gap-2 rounded-lg border border-border-weak bg-bg-base px-3 focus-within:border-border-strong">
            <Icon name="magnifying-glass" class="size-4 shrink-0 text-icon-weak" />
            <input
              type="text"
              data-action="skill-search"
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder={language.t("skills.search.placeholder")}
              class="min-w-0 flex-1 bg-transparent text-body text-fg-base placeholder:text-fg-weaker focus:outline-none"
            />
          </label>
        </div>

        <Switch>
          {/* Reserve the row band's height so the layout doesn't jump when the
              list lands; no "Loading…" copy (local skills resolve fast, and the
              label would just flicker). */}
          <Match when={view() === "loading"}>
            <div data-component="skills-loading" class="px-2.5 py-16" aria-hidden="true" />
          </Match>
          <Match when={view() === "error"}>
            <div data-component="skills-error" class="px-2.5 py-16 text-center text-body text-fg-weak">
              {language.t("skills.error.title")}
            </div>
          </Match>
          <Match when={view() === "empty"}>
            <div data-component="skills-empty" class="px-2.5 py-16 text-center text-body text-fg-weak">
              {language.t("skills.empty.title")}
            </div>
          </Match>
          <Match when={view() === "list"}>
            <div class="mt-6 grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              <For each={filtered()}>{(skill) => <SkillRow skill={skill} onOpen={() => setSelected(skill)} />}</For>
            </div>
          </Match>
        </Switch>
      </div>

      <Show when={selected()}>
        {(skill) => (
          <SkillDetail
            skill={skill()}
            onClose={() => setSelected(undefined)}
            footer={
              <Button variant="primary" data-action="skill-use-in-chat" onClick={() => props.onUseSkill(skill().name)}>
                {language.t("skills.detail.useInChat")}
              </Button>
            }
          />
        )}
      </Show>
    </section>
  )
}
