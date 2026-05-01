export function PawworkWorktreeBadge(props: { name: string; branch?: string; directory?: string }) {
  return (
    <div
      class="flex h-6 max-w-[180px] min-w-0 items-center rounded px-1 text-13-medium text-text-weak"
      data-component="pawwork-worktree-badge"
      title={[props.branch, props.directory].filter(Boolean).join(" · ")}
    >
      <span class="min-w-0 truncate">{props.name}</span>
    </div>
  )
}
