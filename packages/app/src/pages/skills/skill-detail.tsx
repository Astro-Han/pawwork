import { type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { skillTitle, type SkillInfo } from "./skill-presentation"

// Focused single-skill reader, mounted through the shared dialog stack
// (useDialog().show). The dialog base owns the modal shell — overlay, focus
// trap, initial focus, Escape, focus restore, background inert — so this only
// composes the content: humanized title + raw description in the header, the
// SKILL.md markdown in the body, location + actions in the sticky footer. No
// prev/next.
export function SkillDetail(props: { skill: SkillInfo; footer?: JSX.Element }): JSX.Element {
  const language = useLanguage()
  return (
    <Dialog
      size="large"
      title={
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
      }
      description={props.skill.description?.trim() ? props.skill.description : undefined}
      footer={
        <div class="flex w-full items-center justify-between gap-3">
          <span class="min-w-0 truncate font-mono text-caption text-fg-weaker">{props.skill.location}</span>
          {props.footer}
        </div>
      }
    >
      {/* `skill-detail` is the e2e handle for "the reader is open"; keep it. */}
      <div data-component="skill-detail" class="min-h-0 flex-1 overflow-auto px-6 pb-2 pt-4">
        <Markdown text={props.skill.content} cacheKey={props.skill.name} class="text-body" />
      </div>
    </Dialog>
  )
}
