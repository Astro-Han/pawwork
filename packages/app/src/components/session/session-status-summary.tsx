import { For, Show, createMemo, type Accessor, type JSX } from "solid-js"
import { TodoStatusMarker } from "@opencode-ai/ui/todo-status-marker"
import type { Part } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { extractSources } from "@/pages/session/session-status-extractors"
import { selectSessionTodoDataSnapshot } from "@/pages/session/session-todos"
import type { SessionTodoItem } from "@/pages/session/todos/todo-model"
import type { CanonicalTodoSnapshot } from "@/pages/session/todos/todo-source"

function Section(props: { title: string; children: JSX.Element }) {
  // No divider — sections are separated by 24px of breathing room only.
  // Hairlines felt too "boxed in" against the warm-neutral surface; the
  // generous py-6 (24px top + 24px bottom = 48px between sections) reads
  // as a calm pause without enclosing each section in chrome.
  return (
    <div class="flex flex-col gap-2 px-4 py-6">
      <div class="text-caption text-fg-weak">{props.title}</div>
      {props.children}
    </div>
  )
}

function Empty(props: { text: string }) {
  return <div class="text-body text-fg-weaker">{props.text}</div>
}

function TodoRow(props: { todo: SessionTodoItem }) {
  const isDone = () => props.todo.status === "completed" || props.todo.status === "cancelled"
  return (
    <div
      data-slot="status-summary-todo"
      data-state={props.todo.status}
      class="flex items-start gap-2 py-1"
    >
      <TodoStatusMarker status={props.todo.status} marginTop="1px" />
      <div
        class="text-body min-w-0 break-words"
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
  canonical?: Accessor<CanonicalTodoSnapshot | undefined>
  isAuthoritativelyInvalidated?: Accessor<boolean>
  isPending?: Accessor<boolean>
  parts: Accessor<Part[]>
}) {
  const language = useLanguage()
  const snapshot = createMemo(() =>
    selectSessionTodoDataSnapshot({
      primary: {
        canonical: props.canonical?.(),
        isAuthoritativelyInvalidated: props.isAuthoritativelyInvalidated?.() ?? false,
        isPending: props.isPending?.() ?? false,
        parts: props.parts(),
      },
    }),
  )
  const todos = createMemo(() => snapshot().items)
  const sources = createMemo(() => extractSources(props.parts()))

  // No outer wrapper — Section components attach directly to SessionStatusPanel's
  // scroll container, so the first:border-t-0 selector correctly drops the leading
  // hairline regardless of how SessionStatusSummary is placed inside.
  return (
    <>
      <Show when={snapshot().phase !== "pending"}>
        <Section title={language.t("status.summary.progress")}>
          <Show when={todos().length > 0} fallback={<Empty text={language.t("status.summary.progress.empty")} />}>
            <div class="flex flex-col">
              <For each={todos()}>{(todo) => <TodoRow todo={todo} />}</For>
            </div>
          </Show>
        </Section>
      </Show>

      <Section title={language.t("status.summary.sources")}>
        <Show when={sources().length > 0} fallback={<Empty text={language.t("status.summary.sources.empty")} />}>
          <div class="flex flex-col">
            <For each={sources()}>{(url) => <SourceRow url={url} />}</For>
          </div>
        </Show>
      </Section>
    </>
  )
}
