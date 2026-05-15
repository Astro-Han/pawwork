import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import type { Part } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { extractSources } from "@/pages/session/session-status-extractors"
import { selectSessionTodos } from "@/pages/session/session-todos"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"

const TODO_STATUS_STYLES: Record<string, { dot: string; text: string }> = {
  completed: { dot: "bg-icon-success-base", text: "" },
  in_progress: { dot: "bg-icon-info-base", text: "" },
  pending: { dot: "bg-border-weak", text: "" },
  cancelled: { dot: "bg-border-weak", text: "line-through text-fg-weaker" },
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2 px-4 py-3">
      <div class="text-13-medium uppercase tracking-wide text-fg-weaker">{props.title}</div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div class="text-13-regular text-fg-weaker">{props.text}</div>
}

function TodoRow(props: { todo: SessionTodoItem }) {
  const style = () => TODO_STATUS_STYLES[props.todo.status] ?? TODO_STATUS_STYLES.pending
  return (
    <div class="flex items-start gap-2.5 py-1">
      <div class={`size-2 rounded-full shrink-0 mt-1.5 ${style().dot}`} aria-hidden />
      <div class={`text-13-regular text-fg-base min-w-0 ${style().text}`}>{props.todo.content}</div>
    </div>
  )
}

function SourceRow(props: { url: string }) {
  return (
    <div class="flex items-center gap-2 py-1" title={props.url}>
      <span class="text-13-regular text-fg-base truncate min-w-0">{props.url}</span>
    </div>
  )
}

export function SessionStatusSummary(props: { parts: Accessor<Part[]> }) {
  const language = useLanguage()
  const todos = createMemo(() => selectSessionTodos({ parts: props.parts() }))
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
