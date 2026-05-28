import type { AssistantMessage, Part, ReasoningPart, ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { contextTrowSummaryText } from "@opencode-ai/ui/message-part"

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const value = params[String(rawKey)]
    return value === undefined ? "" : String(value)
  })
}

export const zhI18n = {
  locale: () => "zh",
  t: (key: UiI18nKey, params?: UiI18nParams) => {
    const value = (zh as Record<string, string>)[key] ?? String(key)
    return resolveTemplate(value, params)
  },
}

export const labels = {
  summaryRunning: (count: number) => `正在处理 ${count} 个工具调用`,
  summaryCompleted: (parts: readonly ToolPart[], failed: number) => contextTrowSummaryText(parts, failed, zhI18n),
}

export const fixtureData = {
  session: [],
  session_status: {},
  turn_change_aggregate: {},
  message: {},
  part: {},
}

export const snapAssistantMessage = {
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

export const snapStreamingAssistantMessage = {
  ...snapAssistantMessage,
  id: "snap-streaming-message",
  time: { created: 0 },
} as AssistantMessage

export function tool(
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

export function reasoning(id: string, text: string): ReasoningPart {
  return {
    id,
    sessionID: "snap-session",
    messageID: "snap-message",
    type: "reasoning",
    text,
    time: { start: 0, end: 1 },
  }
}

// Pure reasoning, no tools — exercises the single-row path. Must show only
// one leading icon (the trow summary's), never a second icon on the inner row.
export const reasoningOnlyParts: Part[] = [
  reasoning(
    "reason-solo",
    "用户想要一个纯思考的折叠行。\n\n**第一步**，确认这是一段思考。\n\n**第二步**，把它折进会话行里。",
  ),
]

export const runningReasoningParts: Part[] = [
  {
    ...reasoning(
      "reason-running",
      "正在分析用户的问题，并且这段思考还在流式更新。\n\n展开后应该能看到这段实时内容。",
    ),
    messageID: snapStreamingAssistantMessage.id,
  },
]

// Reasoning interleaved with tool calls — exercises the grouped body. The
// reasoning row sits among the tools as a peer, with no duplicated icon.
export const reasoningWithToolsParts: Part[] = [
  reasoning("reason-lead", "先看一下项目结构，再决定从哪里入手。"),
  tool("reason-list", "list files", "ls -la"),
  realTool("reason-read", "read", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
]

export const completedParts = [
  tool("first", "first command", "echo one"),
  tool("second", "second command", "echo two"),
  tool("third", "third command", "echo three"),
]

export const activitySummaryParts = [
  realTool("summary-read", "read", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
  tool("summary-bash", "Find titlebar CSS rules", "rg titlebar"),
  realTool("summary-grep", "grep", { path: "/Users/yuhan/PawWork", pattern: "titlebar" }),
  realTool("summary-websearch", "websearch", { query: "PawWork titlebar icon" }),
  realTool("summary-webfetch", "webfetch", { url: "https://example.com/" }),
  realTool("summary-edit", "edit", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
  realTool("summary-skill", "skill", { name: "debug" }),
]

export const failedParts = [
  tool("failed-command", "Failing command", "exit 1", "error"),
  realTool("failed-read", "read", { filePath: "/Users/yuhan/PawWork/titlebar.tsx" }),
]

export const runningParts = [
  tool("first-running", "first command", "echo one"),
  tool("second-running", "second command", "echo two"),
  tool("third-running", "third command", "echo three", "running"),
]

export const singleQuietParts = [tool("single-quiet", "quiet command", "sleep 0", "completed", "")]
export const singleResultParts = [tool("single-result", "prints one line", "echo one")]
export const singleErrorParts = [tool("single-error", "Command blocked", "rm -rf /", "error")]
export const singleRunningParts = [tool("single-running", "long command", "sleep 30", "running")]

export const toolOutputParts = [
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

export const mixedRealToolParts = [
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

export const questionDetailParts = [
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

export const dismissedQuestionParts = [
  realTool(
    "dismissed-question-real",
    "question",
    {
      questions: [
        {
          header: "Follow up",
          question: "要继续吗?",
          options: [{ label: "继续" }],
        },
      ],
    },
    "",
    { dismissed: true },
  ),
  realTool("dismissed-question-skill", "skill", { name: "debug" }),
]

export const metadataDetailParts = [
  realTool(
    "metadata-detail-question",
    "question",
    {
      questions: [
        {
          header: "Follow up",
          question: "这组工具详情还能看到吗?",
          options: [{ label: "可以" }],
        },
      ],
    },
    "",
    { answers: [["可以"]] },
  ),
  realTool("metadata-detail-edit", "edit", {
    filePath: "/Users/yuhan/PawWork/temp/tool-test-output.md",
    oldString: "before",
    newString: "after",
  }),
  realTool("metadata-detail-write", "write", {
    filePath: "/Users/yuhan/PawWork/temp/new-file.md",
    content: "# New file\n\nhello",
  }),
  realTool(
    "metadata-detail-patch",
    "apply_patch",
    {},
    "",
    {
      files: [
        {
          filePath: "/Users/yuhan/PawWork/temp/patched-file.md",
          relativePath: "temp/patched-file.md",
          type: "add",
          before: "",
          after: "# Patched file\n",
          additions: 1,
          deletions: 0,
        },
      ],
    },
  ),
]
