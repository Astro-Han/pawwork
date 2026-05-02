import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"

function WorktreeTooltipRow(props: { label: string; value?: string; emphasis?: boolean }) {
  return (
    <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
      <span class="text-12-regular [color:var(--text-invert-weaker)]">{props.label}</span>
      <span
        classList={{
          "text-13-medium [color:var(--text-invert-strong)]": props.emphasis,
          "text-13-regular [color:var(--text-invert-base)]": !props.emphasis,
        }}
        class="min-w-0 break-all leading-[1.45]"
      >
        {props.value || "Not available"}
      </span>
    </div>
  )
}

export function PawworkWorktreeBadge(props: {
  name: string
  branch?: string
  directory?: string
  onClick: () => void
  ariaLabel: string
  disabled?: boolean
}) {
  const label = () => props.name || props.branch || props.directory || "Worktree"
  const tooltip = () => (
    <div data-component="pawwork-worktree-tooltip" class="grid min-w-0 gap-1.5 py-1 text-left">
      <WorktreeTooltipRow label="Worktree" value={props.name} emphasis />
      <WorktreeTooltipRow label="Branch" value={props.branch} />
      <WorktreeTooltipRow label="Location" value={props.directory} />
    </div>
  )

  return (
    <Tooltip placement="bottom" value={tooltip()} contentClass="max-w-[420px] px-3 py-2" class="shrink min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="small"
        class="group h-6 max-w-[280px] min-w-0 shrink items-center gap-1 rounded px-1 shadow-none text-13-regular text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong"
        data-component="pawwork-worktree-badge"
        onClick={props.onClick}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
      >
        <Icon
          name="worktree"
          size="small"
          class="shrink-0 text-text-weak transition-colors group-hover:text-text-strong"
        />
        <span class="min-w-0 truncate">{label()}</span>
      </Button>
    </Tooltip>
  )
}
