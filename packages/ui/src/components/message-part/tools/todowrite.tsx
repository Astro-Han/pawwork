import { createMemo, For, Show } from "solid-js"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { TodoStatusMarker } from "../../todo-status-marker"
import { ToolRegistry } from "../registry"

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <div data-slot="message-part-todo-item" data-state={todo.status}>
                  <TodoStatusMarker status={todo.status} />
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})
