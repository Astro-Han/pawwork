import { Show, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { skillTitle, type SkillInfo } from "./skill-presentation"

// Focused single-skill reader, mounted through the shared dialog stack
// (useDialog().show). The dialog base owns the modal shell — overlay, focus
// trap, initial focus, Escape, focus restore, background inert — so this only
// composes the content: the humanized title in the header (the raw slug is
// dropped here — it only echoes the title and reappears in the footer path),
// then a bordered cream summary card carrying the verbatim frontmatter
// description (a real outline keeps the machine-facing blurb from blurring into
// the SKILL.md markdown below it), location + actions in the sticky footer.
// No prev/next.
export function SkillDetail(props: { skill: SkillInfo; footer?: JSX.Element }): JSX.Element {
  const language = useLanguage()
  const description = () => props.skill.description?.trim()
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
          </div>
        </div>
      }
      footer={
        <div class="flex w-full items-center justify-between gap-3">
          <span class="min-w-0 truncate font-mono text-caption text-fg-weaker">{props.skill.location}</span>
          {props.footer}
        </div>
      }
    >
      {/* `skill-detail` is the e2e handle for "the reader is open"; keep it. */}
      <div data-component="skill-detail" class="min-h-0 flex-1 overflow-auto px-6 pb-2 pt-4">
        <Show when={description()}>
          {(summary) => (
            <div class="mb-5 rounded-md border border-border-weak bg-bg-cream px-4 py-3">
              <p class="text-body text-fg-base">{summary()}</p>
            </div>
          )}
        </Show>
        <Markdown text={props.skill.content} cacheKey={props.skill.name} class="text-body" />
      </div>
    </Dialog>
  )
}
