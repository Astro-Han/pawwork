import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"

function WorktreeTooltipRow(props: { label: string; value?: string; emphasis?: boolean }) {
  return (
    <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
      <span class="text-caption [color:var(--fg-on-brand)]">{props.label}</span>
      <span
        classList={{
          "text-h3 [color:var(--fg-on-brand)]": props.emphasis,
          "text-body [color:var(--fg-on-brand)]": !props.emphasis,
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
        class="group h-[26px] max-w-[280px] min-w-0 shrink items-center gap-1 rounded px-1 shadow-none text-body text-fg-weak transition-colors hover:bg-surface-raised hover:text-fg-strong"
        data-component="pawwork-worktree-badge"
        onClick={props.onClick}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
      >
        <Icon
          name="worktree"
          class="shrink-0 text-fg-weak transition-colors group-hover:text-fg-strong"
        />
        <span class="min-w-0 truncate">{label()}</span>
      </Button>
    </Tooltip>
  )
}
