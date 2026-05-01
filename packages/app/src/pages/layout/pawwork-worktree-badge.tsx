import { Icon } from "@opencode-ai/ui/icon"

export function PawworkWorktreeBadge(props: { name: string; branch?: string; directory?: string }) {
  return (
    <div
      class="flex h-6 max-w-[180px] shrink min-w-0 items-center gap-1 rounded-md border border-line-base bg-surface-base px-1.5 text-12-medium text-text-strong"
      data-component="pawwork-worktree-badge"
      title={[props.branch, props.directory].filter(Boolean).join(" · ")}
    >
      <Icon name="worktree" size="small" class="shrink-0 text-icon-weak" />
      <span class="min-w-0 truncate">{props.name}</span>
    </div>
  )
}
