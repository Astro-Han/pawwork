import { Show, createEffect, createMemo, on, onCleanup } from "solid-js"
import type { TerminalTab as TerminalTabType } from "@/context/terminal-types"
import { Terminal } from "@/components/terminal"
import { useTerminal } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"
import { terminalProbe } from "@/testing/terminal"

const FOCUS_DELAYS = [120, 240]

/**
 * Render a single terminal in the right panel. The outer right-panel tab
 * strip owns multi-terminal selection/reorder/close (each terminal is its
 * own outer tab). This component is just the body.
 *
 * `active` reflects whether this terminal's outer tab is the currently
 * selected sidePanelTab — used to gate focus and ensureLive.
 */
export function TerminalPanel(props: { tab: TerminalTabType; active: () => boolean }) {
  const terminal = useTerminal()
  let root: HTMLDivElement | undefined

  const tabID = createMemo(() => props.tab.tabID)

  const focus = (id: string) => {
    const probe = terminalProbe(id)
    probe.focus(FOCUS_DELAYS.length + 1)
    focusTerminalById(id)

    const frame = requestAnimationFrame(() => {
      probe.step()
      if (!props.active()) return
      if (terminal.active() !== id) return
      focusTerminalById(id)
    })

    const timers = FOCUS_DELAYS.map((ms) =>
      window.setTimeout(() => {
        probe.step()
        if (!props.active()) return
        if (terminal.active() !== id) return
        focusTerminalById(id)
      }, ms),
    )

    return () => {
      probe.focus(0)
      cancelAnimationFrame(frame)
      for (const timer of timers) clearTimeout(timer)
    }
  }

  createEffect(
    on(
      () => [props.active(), tabID()] as const,
      ([nowActive, id]) => {
        if (!nowActive || !id) return
        void terminal.ensureLive(id).catch((error) => {
          console.error("Failed to create terminal runtime", error)
        })
        const stop = focus(id)
        onCleanup(stop)
      },
    ),
  )

  createEffect(() => {
    if (props.active()) return
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) return
    if (!root?.contains(focused)) return
    focused.blur()
  })

  const connection = createMemo(() => terminal.connection(tabID()))

  return (
    <div
      ref={root}
      data-component="terminal-panel"
      class="size-full min-h-0 flex flex-col bg-bg-base pt-2"
    >
      <Show
        when={connection()}
        fallback={
          <div class="flex-1 flex items-center justify-center text-fg-weak text-body">
            {/* Skeleton while the runtime spins up. Brief and silent intentionally —
                rich empty states would flash during normal use. */}
          </div>
        }
      >
        {(conn) => (
          <div id={`terminal-wrapper-${tabID()}`} class="flex-1 min-h-0 relative">
            <Terminal
              tab={props.tab}
              connection={conn()}
              autoFocus={props.active()}
              onConnect={() => terminal.snapshot(tabID(), {})}
              onTerminalResize={(size) => terminal.resize(tabID(), size)}
              onSnapshot={(snapshot) => terminal.snapshot(tabID(), snapshot)}
              onGone={() => terminal.markGone(tabID())}
              onError={() => terminal.markGone(tabID())}
            />
          </div>
        )}
      </Show>
    </div>
  )
}
