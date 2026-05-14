import { createMemo, For, Show } from "solid-js"
import type { Todo } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../../context/i18n"
import { BasicTool } from "../../basic-tool"
import { Icon } from "../../icon"
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
                  <Show
                    when={todo.status === "in_progress"}
                    fallback={
                      <Icon
                        name={todo.status === "completed" ? "circle-check" : "circle"}
                        style={{ color: "var(--icon-base)", "flex-shrink": "0" }}
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
