import type { Todo } from "@opencode-ai/sdk/v2"
import { AnimatedNumber } from "@opencode-ai/ui/animated-number"
import { Icon } from "@opencode-ai/ui/icon"
import { DockSegment } from "@opencode-ai/ui/dock-card"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DockWidgetHeader } from "@/pages/session/composer/dock-widget-header"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import { TextStrikethrough } from "@opencode-ai/ui/text-strikethrough"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Index, Show, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { composerEnabled, composerProbe } from "@/testing/session-composer"
import { useLanguage } from "@/context/language"
import { DOCK_MOTION } from "@/pages/session/composer/motion"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"

const currentToken = "\u0000current\u0000"
const totalToken = "\u0000total\u0000"


export function SessionTodoDock(props: {
  sessionID?: string
  todos: SessionTodoItem[]
  collapseLabel: string
  expandLabel: string
  dockProgress: number
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: true,
    height: 320,
  })

  const toggle = () => setStore("collapsed", (value) => !value)

  const total = createMemo(() => props.todos.length)
  // "current" = the step the user is on (1-indexed). It's the first non-finished
  // item, or `total` once everything is done.
  const current = createMemo(() => {
    if (total() === 0) return 0
    const idx = props.todos.findIndex((todo) => todo.status !== "completed" && todo.status !== "cancelled")
    if (idx === -1) return total()
    return idx + 1
  })
  const allCancelled = createMemo(() => total() > 0 && props.todos.every((todo) => todo.status === "cancelled"))
  const label = createMemo(() => {
    if (allCancelled()) return language.t("session.todo.cancelled")
    return language.t("session.todo.progress", { current: current(), total: total() })
  })
  const progress = createMemo(() => {
    if (allCancelled()) return [language.t("session.todo.cancelled")]
    return language
      .t("session.todo.progress", { current: currentToken, total: totalToken })
      .split(/(\u0000current\u0000|\u0000total\u0000)/)
  })

  const active = createMemo(
    () =>
      props.todos.find((todo) => todo.status === "in_progress") ??
      props.todos.find((todo) => todo.status === "pending") ??
      props.todos.filter((todo) => todo.status === "completed").at(-1) ??
      props.todos[0],
  )

  const preview = createMemo(() => active()?.content ?? "")
  const collapse = useSpring(() => (store.collapsed ? 1 : 0), DOCK_MOTION)
  const dock = createMemo(() => Math.max(0, Math.min(1, props.dockProgress)))
  const shut = createMemo(() => 1 - dock())
  const value = createMemo(() => Math.max(0, Math.min(1, collapse())))
  const hide = createMemo(() => Math.max(value(), shut()))
  const off = createMemo(() => hide() > 0.98)
  const turn = createMemo(() => Math.max(0, Math.min(1, value())))
  // Collapsed widget height is 36 per DESIGN.md L305: 30 chev centered → 3+3
  // breathing. See DockWidgetHeader for the wrapper flex fix that makes that
  // breathing actually symmetric.
  const full = createMemo(() => Math.max(36, store.height))
  const e2e = composerEnabled()
  const probe = composerProbe(props.sessionID)
  let contentRef: HTMLDivElement | undefined

  createEffect(() => {
    const el = contentRef
    if (!el) return
    const update = () => {
      setStore("height", el.getBoundingClientRect().height)
    }
    update()
    createResizeObserver(el, update)
  })

  createEffect(() => {
    if (!e2e) return

    probe.set({
      mounted: true,
      collapsed: store.collapsed,
      hidden: store.collapsed || off(),
      count: props.todos.length,
      states: props.todos.map((todo) => todo.status),
    })
  })

  onCleanup(() => {
    if (!e2e) return
    probe.drop()
  })

  return (
    <DockSegment
      data-component="session-todo-dock"
      style={{
        "overflow-x": "visible",
        "overflow-y": "hidden",
        // dock() drives the 0 → visible mount slide-in (fed by parent spring
        // when props.state.dock() flips true). Inner factor is the collapse
        // animation: 36 collapsed, full when expanded. Multiplied so both
        // animations compose without double-clamping at min 36.
        "max-height": `${dock() * Math.max(36, full() - value() * (full() - 36))}px`,
      }}
    >
      <div ref={contentRef}>
        <DockWidgetHeader
          data-action="session-todo-toggle"
          onToggle={toggle}
          chev={
            <IconButton
              data-action="session-todo-toggle-button"
              data-collapsed={store.collapsed ? "true" : "false"}
              icon="chevron-down"
              style={{ transform: `rotate(${turn() * 180}deg)` }}
              onMouseDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                toggle()
              }}
              aria-label={store.collapsed ? props.expandLabel : props.collapseLabel}
            />
          }
        >
          <span
            data-slot="session-todo-progress"
            class="text-13-regular text-fg-strong cursor-default inline-flex items-center shrink-0 overflow-visible leading-none"
            aria-label={label()}
            style={{
              "--tool-motion-odometer-ms": "600ms",
              "--tool-motion-mask": "18%",
              "--tool-motion-mask-height": "0px",
              "--tool-motion-spring-ms": "560ms",
              "white-space": "pre",
              opacity: `${Math.max(0, Math.min(1, 1 - shut()))}`,
            }}
          >
            <Index each={progress()}>
              {(item) =>
                item() === currentToken ? (
                  <AnimatedNumber value={current()} />
                ) : item() === totalToken ? (
                  <AnimatedNumber value={total()} />
                ) : (
                  <span>{item()}</span>
                )
              }
            </Index>
          </span>
          <div
            data-slot="session-todo-preview"
            class="ml-1 min-w-0 overflow-hidden"
            style={{
              flex: "1 1 auto",
              "max-width": "100%",
            }}
          >
            <TextReveal
              class="text-13-regular text-fg-base cursor-default leading-none"
              text={store.collapsed ? preview() : undefined}
              duration={600}
              travel={25}
              edge={17}
              spring="cubic-bezier(0.34, 1, 0.64, 1)"
              springSoft="cubic-bezier(0.34, 1, 0.64, 1)"
              growOnly
              truncate
            />
          </div>
        </DockWidgetHeader>

        <div
          data-slot="session-todo-list"
          aria-hidden={store.collapsed || off()}
          classList={{
            "pointer-events-none": hide() > 0.1,
          }}
          style={{
            visibility: off() ? "hidden" : "visible",
            opacity: `${Math.max(0, Math.min(1, 1 - hide()))}`,
          }}
        >
          <TodoList todos={props.todos} />
        </div>
      </div>
    </DockSegment>
  )
}

function TodoList(props: { todos: SessionTodoItem[] }) {
  return (
    <div class="relative">
      <div
        class="px-3 pb-2 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar"
        style={{ "overflow-anchor": "none" }}
      >
        <Index each={props.todos}>
          {(todo) => (
            <div
              data-slot="session-todo-item"
              data-state={todo().status}
              class="flex gap-2 items-start"
              style={{
                transition: "opacity 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))",
                opacity: todo().status === "pending" ? "0.94" : "1",
              }}
            >
              <Show
                when={todo().status === "in_progress"}
                fallback={
                  <Icon
                    name={todo().status === "completed" ? "circle-check" : "circle"}
                    style={{ color: "var(--icon-base)", "flex-shrink": "0", "margin-top": "1px" }}
                  />
                }
              >
                <span
                  style={{
                    display: "inline-flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "16px",
                    height: "16px",
                    "flex-shrink": "0",
                    "margin-top": "1px",
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: "13px",
                      height: "13px",
                      "border-radius": "9999px",
                      border: "1.5px solid var(--border-weak)",
                      "border-top-color": "var(--brand-primary)",
                      animation: "var(--animate-pw-spin)",
                    }}
                  />
                </span>
              </Show>
              <TextStrikethrough
                active={todo().status === "completed" || todo().status === "cancelled"}
                text={todo().content}
                class="text-13-regular min-w-0 break-words"
                style={{
                  "line-height": "var(--line-height-normal)",
                  transition:
                    "color 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1)), opacity 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))",
                  color:
                    todo().status === "completed" || todo().status === "cancelled"
                      ? "var(--fg-weak)"
                      : "var(--fg-strong)",
                  opacity: todo().status === "pending" ? "0.92" : "1",
                }}
              />
            </div>
          )}
        </Index>
      </div>
    </div>
  )
}
