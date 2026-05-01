import { createMemo, createSignal, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useParams } from "@solidjs/router"
import { Icon } from "@opencode-ai/ui/icon"
import { useSync } from "@/context/sync"

/**
 * Renders an inline worktree indicator (slug · branch) in the titlebar center slot whenever the
 * active session is bound to a worktree (executionContext.activeDirectory != ownerDirectory).
 * Hidden when the session is at project root, when no session is open, or when there is no
 * activeWorktree on the executionContext.
 */
export function PawworkWorktreeBadge() {
  const params = useParams()
  const sync = useSync()
  const [centerMount, setCenterMount] = createSignal<HTMLElement>()

  onMount(() => {
    setCenterMount(document.getElementById("opencode-titlebar-center") ?? undefined)
  })

  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const exec = createMemo(() => session()?.executionContext)
  const wt = createMemo(() => exec()?.activeWorktree)
  const visible = createMemo(() => {
    const e = exec()
    if (!e) return false
    return e.activeDirectory !== e.ownerDirectory && wt() !== undefined
  })

  return (
    <Show when={visible() && centerMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div
            class="hidden md:flex min-w-0 items-center gap-1.5 text-13-medium text-text-strong"
            data-component="pawwork-worktree-badge"
            title={wt()?.directory}
          >
            <Icon name="worktree" size="small" class="text-text-weak" />
            <span class="min-w-0 truncate">{wt()?.name}</span>
            <Show when={wt()?.branch}>
              <span class="text-text-weak">·</span>
              <span class="min-w-0 truncate text-text-weak">{wt()?.branch}</span>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  )
}
