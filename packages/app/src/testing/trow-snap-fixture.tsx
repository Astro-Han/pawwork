import { render } from "solid-js/web"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { TrowBlock } from "@opencode-ai/ui/session-turn-trow-block"

const labels = {
  summaryRunning: (count: number) => `正在运行 ${count} 条命令`,
  summaryCompleted: (count: number) => `已运行 ${count} 条命令`,
  summaryWithFailed: (count: number, failed: number) => `已运行 ${count} 条命令，${failed} 条失败`,
}

function tool(id: string, description: string, command: string, status: ToolState["status"] = "completed"): ToolPart {
  const input = { command, description }
  const state: ToolState =
    status === "running"
      ? { status: "running", input, time: { start: 0 } }
      : {
          status: "completed",
          input,
          output: command.includes("one") ? "one\n" : command.includes("two") ? "two\n" : "three\n",
          title: description,
          metadata: {},
          time: { start: 0, end: 1 },
        }

  return {
    id,
    sessionID: "snap-session",
    messageID: "snap-message",
    type: "tool",
    callID: `call-${id}`,
    tool: "bash",
    state,
  }
}

const completedParts = [
  tool("first", "first command", "echo one"),
  tool("second", "second command", "echo two"),
  tool("third", "third command", "echo three"),
]

const runningParts = [
  tool("first-running", "first command", "echo one"),
  tool("second-running", "second command", "echo two"),
  tool("third-running", "third command", "echo three", "running"),
]

function describeTool(part: ToolPart) {
  const description = part.state.input?.description
  return `执行命令${typeof description === "string" && description ? ` ${description}` : ""}`
}

function renderTool(prefix: string, openTool?: string) {
  return (part: ToolPart) => {
    const input = part.state.input ?? {}
    const command = typeof input.command === "string" ? input.command : ""
    const description = typeof input.description === "string" ? input.description : undefined
    const output = part.state.status === "completed" ? part.state.output : ""
    return (
      <div data-slot="trow-result-body" data-timeline-anchor={`tool:${part.id}`}>
        <BasicTool
          icon="console"
          status={part.state.status}
          defaultOpen={part.id === openTool}
          stateKey={`${prefix}:${part.id}`}
          trigger={{ title: "执行命令", subtitle: description }}
        >
          <BashOutput command={command} output={output} />
        </BasicTool>
      </div>
    )
  }
}

function BashOutput(props: { command: string; output?: string }) {
  return (
    <div data-component="bash-output">
      <div data-slot="bash-scroll" data-scrollable>
        <pre data-slot="bash-pre">
          <code>{`$ ${props.command}${props.output ? `\n\n${props.output.trim()}` : ""}`}</code>
        </pre>
      </div>
    </div>
  )
}

function DirectBashTool(props: {
  description: string
  command: string
  output?: string
  stateKey: string
  status?: string
  defaultOpen?: boolean
}) {
  return (
    <BasicTool
      icon="console"
      status={props.status}
      defaultOpen={props.defaultOpen}
      trigger={{ title: "执行命令", subtitle: props.description }}
      stateKey={props.stateKey}
    >
      <BashOutput command={props.command} output={props.output} />
    </BasicTool>
  )
}

function TrowSnapFixture() {
  return (
    <div
      style={{
        display: "grid",
        gap: "18px",
        padding: "24px",
        background: "var(--bg-base)",
        color: "var(--fg-base)",
        width: "760px",
      }}
    >
      <div data-snap="running-current">
        <TrowBlock
          parts={runningParts}
          working
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("running")}
        />
      </div>
      <div data-snap="mixed-collapsed">
        <TrowBlock
          parts={completedParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("collapsed")}
        />
      </div>
      <div data-snap="mixed-expanded">
        <TrowBlock
          parts={completedParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("expanded")}
        />
      </div>
      <div data-snap="inner-bash-expanded">
        <TrowBlock
          parts={completedParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("inner", "third")}
        />
      </div>
      <div data-snap="single-command-direct">
        <DirectBashTool
          description="quiet command"
          command="sleep 0"
          output=""
          stateKey="single-command-direct"
        />
      </div>
      <div data-snap="single-command-expanded">
        <DirectBashTool
          description="prints one line"
          command="echo single"
          output="single"
          stateKey="single-command-expanded"
          defaultOpen
        />
      </div>
      <div data-snap="single-command-running">
        <DirectBashTool
          description="long command"
          command="sleep 30"
          stateKey="single-command-running"
          status="running"
        />
      </div>
    </div>
  )
}

export function mountTrowSnapFixture(root: HTMLElement) {
  root.innerHTML = ""
  render(() => <TrowSnapFixture />, root)
}
