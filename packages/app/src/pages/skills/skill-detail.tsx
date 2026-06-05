import { type JSX, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { useLanguage } from "@/context/language"
import { skillTitle, type SkillInfo } from "./skill-presentation"

// Focused single-skill reader. Header carries the humanized title and the raw
// description verbatim; the body renders the SKILL.md markdown. No prev/next.
export function SkillDetail(props: { skill: SkillInfo; footer?: JSX.Element; onClose: () => void }): JSX.Element {
  const language = useLanguage()
  return (
    <div
      data-component="skill-detail-scrim"
      class="absolute inset-0 z-20 flex items-center justify-center bg-[rgb(26_22_19_/_0.16)] px-6"
      onClick={props.onClose}
    >
      <div
        data-component="skill-detail"
        role="dialog"
        aria-modal="true"
        aria-label={skillTitle(props.skill.name)}
        class="relative flex max-h-[80%] w-[600px] flex-col overflow-hidden rounded-xl bg-bg-base shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          data-action="skill-detail-close"
          aria-label={language.t("common.close")}
          onClick={props.onClose}
          class="absolute right-4 top-4 flex size-7 items-center justify-center rounded-md text-fg-weak hover:bg-row-hover-overlay hover:text-fg-strong focus:outline-none"
        >
          <Icon name="close" class="size-3.5" />
        </button>

        <div class="shrink-0 px-6 pt-6">
          <div class="flex items-center gap-3">
            <span class="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface-interactive-base">
              <Icon name="skill" class="size-5 text-brand-primary" />
            </span>
            <div class="min-w-0">
              <div class="text-h2 text-fg-strong">
                {skillTitle(props.skill.name)}
                <span class="ml-1.5 font-normal text-fg-weaker">{language.t("skills.detail.suffix")}</span>
              </div>
              <div class="mt-0.5 font-mono text-caption text-fg-weaker">{props.skill.name}</div>
            </div>
          </div>
          <Show when={props.skill.description?.trim()}>
            <p class="mt-3.5 text-body leading-relaxed text-fg-base">{props.skill.description}</p>
          </Show>
        </div>

        <div class="min-h-0 flex-1 overflow-auto px-6 pb-2 pt-4">
          <Markdown text={props.skill.content} cacheKey={props.skill.name} class="text-body" />
        </div>

        <Show when={props.footer}>
          <div
            data-component="skill-detail-foot"
            class="flex shrink-0 items-center justify-between gap-3 border-t border-border-weaker px-6 py-3"
          >
            <span class="min-w-0 truncate font-mono text-caption text-fg-weaker">{props.skill.location}</span>
            {props.footer}
          </div>
        </Show>
      </div>
    </div>
  )
}
