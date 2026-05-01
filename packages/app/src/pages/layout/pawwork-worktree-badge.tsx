import { Icon } from "@opencode-ai/ui/icon"

export function PawworkWorktreeBadge(props: {
  name: string
  branch?: string
  directory?: string
  onClick?: () => void
  ariaLabel?: string
  disabled?: boolean
}) {
  const title = () => [props.branch, props.directory].filter(Boolean).join(" · ")

  return (
    <button
      type="button"
      class="group flex h-6 max-w-[180px] min-w-0 shrink items-center gap-1 rounded px-1 text-13-regular text-text-weak transition-colors hover:text-text-strong focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-border-active disabled:pointer-events-none disabled:opacity-60"
      data-component="pawwork-worktree-badge"
      title={title() || props.name}
      onClick={props.onClick}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
    >
      <Icon name="worktree" size="small" class="shrink-0 text-text-weaker transition-colors group-hover:text-text-weak" />
      <span class="min-w-0 truncate">{props.name}</span>
    </button>
  )
}
