import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"

export function PawworkWorktreeBadge(props: {
  name: string
  branch?: string
  directory?: string
  onClick: () => void
  ariaLabel: string
  disabled?: boolean
}) {
  const title = () => [props.branch, props.directory].filter(Boolean).join(" · ") || props.name
  const label = () => (props.branch ? `${props.name} (${props.branch})` : props.name)

  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      class="group h-6 max-w-[180px] min-w-0 shrink items-center gap-1 rounded px-1 shadow-none text-13-regular text-text-weak hover:text-text-strong"
      data-component="pawwork-worktree-badge"
      title={title()}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
    >
      <Icon name="worktree" size="small" class="shrink-0 text-text-weak transition-colors group-hover:text-text-strong" />
      <span class="min-w-0 truncate">{label()}</span>
    </Button>
  )
}
