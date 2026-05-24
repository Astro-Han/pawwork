import { Dynamic, render } from "solid-js/web"
import type { AssistantMessage, ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { DataProvider, I18nProvider, type UiI18nKey, type UiI18nParams } from "@opencode-ai/ui/context"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { AssistantParts, contextTrowSummaryText, ToolRegistry } from "@opencode-ai/ui/message-part"
import { TrowBlock } from "@opencode-ai/ui/session-turn-trow-block"

const labels = {
  summaryRunning: (count: number) => `正在处理 ${count} 个工具调用`,
  summaryCompleted: (parts: readonly ToolPart[], failed: number) => contextTrowSummaryText(parts, failed, zhI18n),
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
  let state: ToolState
  switch (status) {
    case "pending":
      state = { status: "pending", input, raw: "" }
      break
    case "running":
      state = { status: "running", input, time: { start: 0 } }
      break
    case "error":
      state = { status: "error", input, error: "Command failed", time: { start: 0, end: 1 } }
      break
    case "completed":
    default:
      state = {
        status: "completed",
        input,
        output: output ?? (command.includes("one") ? "one\n" : command.includes("two") ? "two\n" : "three\n"),
        title: description,
        metadata: {},
        time: { start: 0, end: 1 },
      }
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

const activitySummaryParts = [
  realTool("summary-read", "read", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
  tool("summary-bash", "Find titlebar CSS rules", "rg titlebar"),
  realTool("summary-grep", "grep", { path: "/Users/yuhan/PawWork", pattern: "titlebar" }),
  realTool("summary-websearch", "websearch", { query: "PawWork titlebar icon" }),
  realTool("summary-webfetch", "webfetch", { url: "https://example.com/" }),
  realTool("summary-edit", "edit", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
  realTool("summary-skill", "skill", { name: "debug" }),
]
const failedParts = [
  tool("failed-command", "Failing command", "exit 1", "error"),
  realTool("failed-read", "read", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
]

const runningParts = [
  tool("first-running", "first command", "echo one"),
  tool("second-running", "second command", "echo two"),
  tool("third-running", "third command", "echo three", "running"),
]

const singleQuietParts = [tool("single-quiet", "quiet command", "sleep 0", "completed", "")]
const singleResultParts = [tool("single-result", "prints one line", "echo one")]
const singleErrorParts = [tool("single-error", "Command blocked", "rm -rf /", "error")]
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
  realTool(
    "question-real",
    "question",
    {
      questions: [
        {
          header: "Follow up",
          question: "你想继续深入测试某个工具吗?",
          options: [{ label: "够了" }],
        },
      ],
    },
    "",
    { answers: [["够了"]] },
  ),
]
const questionDetailParts = [
  realTool("question-detail-skill", "skill", { name: "learn-code" }),
  realTool(
    "question-detail-real",
    "question",
    {
      questions: [
        {
          header: "Follow up",
          question: "你想继续深入测试某个工具吗?",
          options: [{ label: "够了" }],
        },
      ],
    },
    "",
    { answers: [["够了"]] },
  ),
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

const snapAssistantMessage = {
  id: "snap-message",
  sessionID: "snap-session",
  role: "assistant",
  time: { created: 0, completed: 1 },
  parentID: "snap-user",
  modelID: "snap-model",
  providerID: "snap-provider",
  mode: "build",
  agent: "code",
  path: { cwd: "/Users/yuhan/PawWork", root: "/Users/yuhan/PawWork" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
} as AssistantMessage

function AssistantPartsCase(props: {
  parts: ToolPart[]
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}) {
  return (
    <DataProvider
      data={{ ...fixtureData, part: { [snapAssistantMessage.id]: props.parts } }}
      directory="/Users/yuhan/PawWork"
    >
      <AssistantParts
        messages={[snapAssistantMessage]}
        shellToolDefaultOpen={props.shellToolDefaultOpen}
        editToolDefaultOpen={props.editToolDefaultOpen}
      />
    </DataProvider>
  )
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
      <div data-snap="activity-summary-collapsed">
        <TrowBlock
          parts={activitySummaryParts}
          labels={labels}
        />
      </div>
      <div data-snap="failed-summary-collapsed">
        <TrowBlock
          parts={failedParts}
          labels={labels}
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
      <div data-snap="question-expanded">
        <TrowBlock
          parts={questionDetailParts}
          defaultOpen
          labels={labels}
          describeTool={describeTool}
          renderTool={renderRegisteredTool("question-detail", "question-detail-real")}
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
      <div data-snap="single-command-error">
        <AssistantPartsCase parts={singleErrorParts} />
      </div>
      <div data-snap="single-shell-setting-collapsed">
        <AssistantPartsCase
          parts={[tool("single-shell-setting-collapsed", "respects shell setting", "echo hidden")]}
          shellToolDefaultOpen={false}
        />
      </div>
      <div data-snap="single-shell-setting-expanded">
        <AssistantPartsCase
          parts={[tool("single-shell-setting-expanded", "respects shell setting", "echo shown")]}
          shellToolDefaultOpen
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
