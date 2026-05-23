import { Dynamic, render } from "solid-js/web"
import type { ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { DataProvider, I18nProvider, type UiI18nKey, type UiI18nParams } from "@opencode-ai/ui/context"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { ToolRegistry } from "@opencode-ai/ui/message-part"
import { TrowBlock } from "@opencode-ai/ui/session-turn-trow-block"

const labels = {
  summaryRunning: (count: number) => `正在运行 ${count} 条命令`,
  summaryCompleted: (count: number) => `已运行 ${count} 条命令`,
  summaryWithFailed: (count: number, failed: number) => `已运行 ${count} 条命令，${failed} 条失败`,
}

function tool(
  id: string,
  description: string,
  command: string,
  status: ToolState["status"] = "completed",
  output?: string,
  toolName = "bash",
): ToolPart {
  const input = { command, description }
  const state: ToolState =
    status === "running"
      ? { status: "running", input, time: { start: 0 } }
      : {
          status: "completed",
          input,
          output: output ?? (command.includes("one") ? "one\n" : command.includes("two") ? "two\n" : "three\n"),
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
    tool: toolName,
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

const singleQuietParts = [tool("single-quiet", "quiet command", "sleep 0", "completed", "")]
const singleResultParts = [tool("single-result", "prints one line", "echo one")]
const singleRunningParts = [tool("single-running", "long command", "sleep 30", "running")]
const toolOutputParts = [
  realTool(
    "glob-output",
    "glob",
    { path: "/Users/yuhan/PawWork", pattern: "*.md" },
    "/Users/yuhan/PawWork/a.md\n/Users/yuhan/PawWork/b.md\n",
  ),
  realTool(
    "grep-output",
    "grep",
    { path: "/Users/yuhan/PawWork", pattern: "test", include: "*.md" },
    "Found 1 matches\n/Users/yuhan/PawWork/a.md:\n  Line 3: test\n",
  ),
]
const mixedRealToolParts = [
  realTool("websearch-real", "websearch", { query: "PawWork desktop app AI agent 2026" }, "https://example.com/"),
  realTool("webfetch-real", "webfetch", { url: "https://example.com/" }),
  realTool(
    "enter-worktree-real",
    "enter-worktree",
    { name: "session-trow-revival" },
    "",
    {
      ownerDirectory: "/Users/yuhan/workspace/dev/pawwork",
      activeDirectory: "/Users/yuhan/workspace/dev/pawwork/.worktrees/session-trow-revival",
    },
  ),
  realTool(
    "exit-worktree-real",
    "exit-worktree",
    {},
    "",
    { activeDirectory: "/Users/yuhan/workspace/dev/pawwork", previousBranch: "session-trow-revival" },
  ),
  realTool("skill-real", "skill", { name: "learn-code" }),
]

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const value = params[String(rawKey)]
    return value === undefined ? "" : String(value)
  })
}

const zhI18n = {
  locale: () => "zh",
  t: (key: UiI18nKey, params?: UiI18nParams) => {
    const value = (zh as Record<string, string>)[key] ?? String(key)
    return resolveTemplate(value, params)
  },
}

const fixtureData = {
  session: [],
  session_status: {},
  turn_change_aggregate: {},
  message: {},
  part: {},
}

function realTool(
  id: string,
  toolName: string,
  input: Record<string, unknown>,
  output = "",
  metadata: Record<string, unknown> = {},
): ToolPart {
  return {
    id,
    sessionID: "snap-session",
    messageID: "snap-message",
    type: "tool",
    callID: `call-${id}`,
    tool: toolName,
    state: {
      status: "completed",
      input,
      output,
      title: toolName,
      metadata,
      time: { start: 0, end: 1 },
    },
  }
}

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

function renderRegisteredTool(prefix: string, openTool?: string) {
  return (part: ToolPart) => {
    const component = ToolRegistry.render(part.tool)
    const state = part.state
    const input = state.input ?? {}
    const output = state.status === "completed" ? state.output : undefined
    const metadata = state.status === "completed" ? (state.metadata ?? {}) : {}
    return (
      <div data-slot="trow-result-body" data-timeline-anchor={`tool:${part.id}`}>
        <Dynamic
          component={component}
          input={input}
          tool={part.tool}
          metadata={metadata}
          output={output}
          status={state.status}
          defaultOpen={part.id === (openTool ?? "websearch-real")}
          stateKey={`${prefix}:${part.id}`}
        />
      </div>
    )
  }
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
      <div
        data-snap="collapsed-followed-by-text"
        data-slot="session-turn-assistant-content"
        style={{ display: "flex", "flex-direction": "column", gap: "12px" }}
      >
        <TrowBlock
          parts={completedParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("collapsed-text")}
        />
        <div data-component="text-part">
          <div data-slot="text-part-body">工具完成后的下一段回复</div>
        </div>
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
      <div data-snap="tool-output-spacing">
        <TrowBlock
          parts={toolOutputParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("tool-output", "glob-output")}
        />
      </div>
      <div data-snap="registered-tool-rows">
        <TrowBlock
          parts={mixedRealToolParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("registered")}
        />
      </div>
      <div data-snap="single-command-direct">
        <TrowBlock
          parts={singleQuietParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-direct", "single-quiet")}
        />
      </div>
      <div data-snap="single-command-expanded">
        <TrowBlock
          parts={singleResultParts}
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-expanded", "single-result")}
        />
      </div>
      <div data-snap="single-command-running">
        <TrowBlock
          parts={singleRunningParts}
          working
          labels={labels}
          describeTool={describeTool}
          renderTool={renderTool("single-running", "single-running")}
        />
      </div>
    </div>
  )
}

export function mountTrowSnapFixture(root: HTMLElement) {
  root.innerHTML = ""
  render(
    () => (
      <I18nProvider value={zhI18n}>
        <MarkedProvider>
          <DataProvider data={fixtureData} directory="/Users/yuhan/PawWork">
            <TrowSnapFixture />
          </DataProvider>
        </MarkedProvider>
      </I18nProvider>
    ),
    root,
  )
}
