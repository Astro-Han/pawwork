import { type Accessor, createMemo, createResource, createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { SkillDetail } from "./skill-detail"
import { skillMatches, skillTitle, type SkillInfo } from "./skill-presentation"

// One capability row: brand-tinted tile + humanized title + the raw description
// clamped to two lines. Two-up rows keep the band compact while the description
// stays legible; borderless, the hover tint is the only affordance.
function SkillRow(props: { skill: SkillInfo; onOpen: () => void }): JSX.Element {
  const description = () => props.skill.description?.trim()
  return (
    <button
      type="button"
      data-action="skill-open"
      data-skill={props.skill.name}
      onClick={props.onOpen}
      class="flex w-full items-start gap-3 rounded-md px-2 py-2.5 text-left hover:bg-row-hover-overlay focus:outline-none focus-visible:bg-row-hover-overlay"
    >
      <span class="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-interactive-base">
        <Icon name="skill" class="size-[18px] text-brand-primary" />
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-h3 text-fg-strong">{skillTitle(props.skill.name)}</span>
        <Show when={description()}>
          {(summary) => <span class="mt-0.5 line-clamp-2 text-caption text-fg-weak">{summary()}</span>}
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
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  // The detail reader is a modal in the shared dialog stack; opening it there
  // gets focus trap / initial focus / focus restore / background inert for free
  // instead of re-deriving them on a hand-rolled overlay. "Use in chat" closes
  // the dialog before navigating so the stack unwinds cleanly.
  const openDetail = (skill: SkillInfo) => {
    dialog.show(() => (
      <SkillDetail
        skill={skill}
        footer={
          <Button
            variant="primary"
            data-action="skill-use-in-chat"
            onClick={() => {
              dialog.close()
              props.onUseSkill(skill.name)
            }}
          >
            {language.t("skills.detail.useInChat")}
          </Button>
        }
      />
    ))
  }

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
  const view = createMemo<"no-directory" | "loading" | "error" | "empty" | "list">(() => {
    // No resolvable directory (zero projects): the gallery cannot list and
    // "Use in chat" has no destination — say so instead of loading forever.
    if (!props.directory()) return "no-directory"
    if (skills.state === "errored") return "error"
    if (skills.state === "pending" || skills.state === "unresolved") return "loading"
    return filtered().length > 0 ? "list" : "empty"
  })

  // Escape closes the surface — but only when nothing in the shared dialog stack
  // owns it. That covers the skill-detail reader AND a command palette opened
  // from the still-live sidebar. `dialog.active` is the single source of truth
  // for "a modal owns Escape", so we defer to it instead of sniffing the DOM for
  // overlay components; we bail without preventing default so the event still
  // reaches whatever modal is up. Only when the stack is empty do we close.
  onMount(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (dialog.active) return
      event.preventDefault()
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
          <Match when={view() === "no-directory"}>
            <div data-component="skills-need-project" class="px-2.5 py-16 text-center text-body text-fg-weak">
              {language.t("skills.needProject.title")}
            </div>
          </Match>
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
            <div class="mt-6 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              <For each={filtered()}>{(skill) => <SkillRow skill={skill} onOpen={() => openDetail(skill)} />}</For>
            </div>
          </Match>
        </Switch>
      </div>
    </section>
  )
}
