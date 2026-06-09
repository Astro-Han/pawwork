import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { TrowBlock, type TrowPart } from "../../src/components/session-turn-trow-block"

export function tool(id: string, name = "bash", output = "done"): ToolPart {
  const state: ToolState = {
    status: "completed",
    input: {},
    output,
    title: "",
    metadata: {},
    time: { start: 0, end: 1 },
  }
  return {
    id,
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: `call-${id}`,
    tool: name,
    state,
  }
}

export function mountTrowBlock(initialParts: TrowPart[]) {
  const [parts, setParts] = createSignal(initialParts)
  const host = document.createElement("div")
  document.body.append(host)

  const disposeRoot = render(
    () => (
      <TrowBlock
        parts={parts()}
        labels={{
          summaryRunning: (count) => `running ${count}`,
          summaryCompleted: (tools) => `completed ${tools.length}`,
          thinking: "thinking",
        }}
        renderPart={(part) => {
          const output = () => {
            const current = part()
            if (current.type !== "tool") return ""
            const state = current.state
            return "output" in state ? (state.output ?? "") : ""
          }
          return <div data-testid={`trow-tool-${part().id}`}>{part().id}:{output()}</div>
        }}
      />
    ),
    host,
  )

  return {
    host,
    setParts,
    body: () => host.querySelector("[data-slot='trow-body']"),
    details: () => host.querySelector("details") as HTMLDetailsElement | null,
    summary: () => host.querySelector("[data-slot='trow-summary']") as HTMLElement | null,
    tool: (id: string) => host.querySelector(`[data-testid='trow-tool-${id}']`),
    dispose: () => {
      disposeRoot()
      host.remove()
    },
  }
}
