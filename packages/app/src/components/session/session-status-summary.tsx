import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import type { Part } from "@opencode-ai/sdk/v2"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { extractSources } from "@/pages/session/session-status-extractors"
import { selectSessionTodos } from "@/pages/session/session-todos"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="text-h3 uppercase tracking-wide text-fg-weaker">{props.title}</div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div class="text-body text-fg-weaker">{props.text}</div>
}

// Status marker mirrors the canonical todo widget (session-todo-dock.tsx + todowrite.tsx):
// completed → circle-check icon, pending/cancelled → circle icon,
// in_progress → 13×13 ring with brand-primary top and pw-spin animation.
// DESIGN.md L201 forbids dots as state signals; this realigns the right-panel Status tab
// with how the same todos render in the composer dock and message timeline.
function TodoMarker(props: { status: SessionTodoItem["status"] }) {
  return (
    <Show
      when={props.status === "in_progress"}
      fallback={
        <Icon
          name={props.status === "completed" ? "circle-check" : "circle"}
          style={{ color: "var(--icon-base)", "flex-shrink": "0", "margin-top": "1px" }}
        />
      }
    >
      <span
        data-slot="status-summary-todo-running"
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
  )
}

function TodoRow(props: { todo: SessionTodoItem }) {
  const isDone = () => props.todo.status === "completed" || props.todo.status === "cancelled"
  return (
    <div
      data-slot="status-summary-todo"
      data-state={props.todo.status}
      class="flex items-start gap-2 py-1"
    >
      <TodoMarker status={props.todo.status} />
      <div
        class="text-body min-w-0"
        classList={{
          "line-through text-fg-weak": isDone(),
          "text-fg-base": !isDone(),
        }}
      >
        {props.todo.content}
      </div>
    </div>
  )
}

function SourceRow(props: { url: string }) {
  return (
    <div class="flex items-center gap-2 py-1" title={props.url}>
      <span class="text-body text-fg-base truncate min-w-0">{props.url}</span>
    </div>
  )
}

export function SessionStatusSummary(props: {
  backend?: Accessor<Todo[] | undefined>
  backendClearActivePartsAt?: Accessor<number | undefined>
  parts: Accessor<Part[]>
}) {
  const language = useLanguage()
  const todos = createMemo(() =>
    selectSessionTodos({
      backend: props.backend?.(),
      backendClearActivePartsAt: props.backendClearActivePartsAt?.(),
      parts: props.parts(),
    }),
  )
  const sources = createMemo(() => extractSources(props.parts()))

  return (
    <div class="flex flex-col">
      <Section title={language.t("status.summary.progress")}>
        <Show when={todos().length > 0} fallback={<Empty text={language.t("status.summary.progress.empty")} />}>
          <div class="flex flex-col">
            <For each={todos()}>{(todo) => <TodoRow todo={todo} />}</For>
          </div>
        </Show>
      </Section>

      <Section title={language.t("status.summary.sources")}>
        <Show when={sources().length > 0} fallback={<Empty text={language.t("status.summary.sources.empty")} />}>
          <div class="flex flex-col">
            <For each={sources()}>{(url) => <SourceRow url={url} />}</For>
          </div>
        </Show>
      </Section>
    </div>
  )
}
