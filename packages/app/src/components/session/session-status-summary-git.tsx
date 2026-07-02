import { Show, createMemo, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { VcsInfo } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { Section } from "./session-status-summary-shell"

export interface ActiveWorktree {
  name: string
  branch?: string
  directory?: string
}

// A row in the Git section. Three shapes:
//   - readonly (no onClick): renders as a non-interactive <div>, no hover bg,
//     no focus ring — matches docs/DESIGN.md L445 "No hover state" for the
//     branch row, and matches the old worktree badge's disabled state when
//     the host can't open paths.
//   - clickable: button with the standard row-hover overlay.
function GitRow(props: {
  icon: string
  onClick?: () => void
  children: JSX.Element
  chevron?: "down" | "right" | false
  title?: string
}) {
  const chevronIcon = () => (props.chevron === "down" ? "chevron-down" : "chevron-right")
  const body = (
    <>
      <Icon name={props.icon as any} class="shrink-0 text-fg-weak" />
      <div class="min-w-0 flex-1">{props.children}</div>
      <Show when={props.chevron}>
        <Icon name={chevronIcon()} class="shrink-0 text-fg-weaker" />
      </Show>
    </>
  )

  return (
    <Show
      when={props.onClick}
      fallback={
        <div class="flex w-full min-h-[30px] items-center gap-2 rounded-md px-2 text-left" title={props.title}>
          {body}
        </div>
      }
    >
      {(onClick) => (
        <button
          type="button"
          class="flex w-full min-h-[30px] items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-[var(--row-hover-overlay)]"
          onClick={() => onClick()()}
          title={props.title}
        >
          {body}
        </button>
      )}
    </Show>
  )
}

export function GitSection(props: {
  vcs: Accessor<VcsInfo | undefined>
  activeWorktree: Accessor<ActiveWorktree | undefined>
  diffStats: Accessor<{ additions: number; deletions: number }>
  onNavigateReview: () => void
  canOpenDirectory: (directory: string) => boolean
  onOpenDirectory: (directory: string) => void
}) {
  const language = useLanguage()
  const hasChanges = createMemo(() => {
    const stats = props.diffStats()
    return stats.additions > 0 || stats.deletions > 0
  })

  const na = () => language.t("status.summary.git.worktree.notAvailable")

  const worktreeTooltip = (worktree: ActiveWorktree) => (
    <div class="grid min-w-0 gap-1.5 py-1 text-left">
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">{language.t("status.summary.git.worktree.label")}</span>
        <span class="text-h3 min-w-0 break-all leading-[1.45]">{worktree.name || na()}</span>
      </div>
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">{language.t("status.summary.git.branch.label")}</span>
        <span class="text-body min-w-0 break-all leading-[1.45]">{worktree.branch || na()}</span>
      </div>
      <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
        <span class="text-caption">{language.t("status.summary.git.location.label")}</span>
        <span class="text-body min-w-0 break-all leading-[1.45]">{worktree.directory || na()}</span>
      </div>
    </div>
  )

  return (
    <Section title={language.t("status.summary.git")}>
      <div class="flex flex-col">
        <GitRow icon="changes" onClick={props.onNavigateReview} chevron="right">
          <Show
            when={hasChanges()}
            fallback={<span class="text-body text-fg-weaker">{language.t("status.summary.git.changes")}</span>}
          >
            <span class="font-mono text-body">
              <span class="text-success">+{props.diffStats().additions}</span>{" "}
              <span class="text-error">−{props.diffStats().deletions}</span>
            </span>
          </Show>
        </GitRow>

        <Show when={props.vcs()?.branch}>
          {(branch) => (
            <GitRow icon="branch">
              <span class="text-body text-fg-base">{branch()}</span>
            </GitRow>
          )}
        </Show>

        <Show when={props.activeWorktree()}>
          {(worktree) => {
            const directory = () => worktree().directory
            const canOpen = () => {
              const dir = directory()
              return !!dir && props.canOpenDirectory(dir)
            }
            const label = () => worktree().name || worktree().branch || language.t("status.summary.git.worktree.fallback")
            const tooltipTitle = canOpen() ? language.t("status.summary.git.worktree.open") : undefined
            return (
              <Tooltip placement="bottom" value={worktreeTooltip(worktree())} contentClass="max-w-[420px] px-3 py-2">
                <GitRow
                  icon="worktree"
                  onClick={canOpen() ? () => props.onOpenDirectory(directory()!) : undefined}
                  title={tooltipTitle}
                >
                  <span class="text-body text-fg-base">{label()}</span>
                </GitRow>
              </Tooltip>
            )
          }}
        </Show>
      </div>
    </Section>
  )
}
