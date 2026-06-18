import { render } from "solid-js/web"
import type { AssistantMessage, NoticePart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { AssistantParts } from "@opencode-ai/ui/message-part"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

// The #1358 terminal notice rendered through the real component pipeline
// (AssistantParts → tool.tsx card + notice.tsx). Two columns cover the adaptive
// copy: a turn that ran a side-effecting tool (operation already landed) vs. a
// turn whose reply never started (no tool).
const SESSION = "ses_recovery_presentation"

function assistant(id: string): AssistantMessage {
  return {
    id,
    role: "assistant",
    sessionID: SESSION,
    parentID: "msg_recovery_user",
    modelID: "test-model",
    providerID: "test-provider",
    mode: "build",
    agent: "build",
    path: { cwd: "/Users/yuhan/PawWork", root: "/Users/yuhan/PawWork" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  }
}

function text(messageID: string): TextPart {
  return {
    id: `${messageID}_text`,
    sessionID: SESSION,
    messageID,
    type: "text",
    text: "我帮你在 issue #1358 下留了一条评论。",
    time: { start: 0, end: 1 },
  }
}

function bashTool(messageID: string): ToolPart {
  return {
    id: `${messageID}_bash`,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: `${messageID}_call`,
    tool: "bash",
    state: {
      status: "completed",
      input: { command: 'gh issue comment 1358 --body "已按方案排期，明天开工。"', description: "在 #1358 下留言" },
      output: "https://github.com/Astro-Han/pawwork/issues/1358#issuecomment-3920481",
      title: "在 #1358 下留言",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

// A completed read-only tool (grep) carries no side effect: it must NOT flip
// the notice to the "操作已完成" reassurance. This column proves the predicate
// excludes read-only tools and falls back to the default "回复未完成" copy.
function grepTool(messageID: string): ToolPart {
  return {
    id: `${messageID}_grep`,
    sessionID: SESSION,
    messageID,
    type: "tool",
    callID: `${messageID}_call`,
    tool: "grep",
    state: {
      status: "completed",
      input: { pattern: "safe_retry_failed", include: "*.tsx" },
      output: "packages/ui/src/components/message-part/parts/notice.tsx",
      title: "搜索 safe_retry_failed",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

function searchText(messageID: string): TextPart {
  return {
    id: `${messageID}_text`,
    sessionID: SESSION,
    messageID,
    type: "text",
    text: "我先在代码里查了下相关实现。",
    time: { start: 0, end: 1 },
  }
}

function notice(messageID: string): NoticePart {
  return {
    id: `${messageID}_notice`,
    sessionID: SESSION,
    messageID,
    type: "notice",
    kind: "safe_retry_failed",
    time: { created: 1 },
  }
}

const i18n = {
  locale: () => "zh",
  t: (key: UiI18nKey, params?: UiI18nParams) => {
    const template = zh[key] ?? String(key)
    return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => String(params?.[String(rawKey)] ?? ""))
  },
}

// AssistantParts reads parts from the DataProvider store by messageID; the real
// notice.tsx reads the same store to pick the side-effect vs. default copy.
function Turn(props: { message: AssistantMessage; parts: (TextPart | ToolPart | NoticePart)[] }) {
  return (
    <MarkedProvider>
      <DataProvider data={{ message: {}, part: { [props.message.id]: props.parts } }} directory="/Users/yuhan/PawWork">
        <AssistantParts messages={[props.message]} />
      </DataProvider>
    </MarkedProvider>
  )
}

function RecoveryPresentationSnapFixture() {
  const sideEffect = assistant("msg_side_effect")
  const readOnly = assistant("msg_read_only")
  const reply = assistant("msg_reply")
  return (
    <I18nProvider value={i18n}>
      <DialogProvider>
        {/* Opaque full-viewport cover at max z-index so the app's dev chrome
            (debug bar, server-health toast) renders behind the captured grid. */}
        <div
          style={{
            position: "fixed",
            inset: "0",
            "z-index": "2147483647",
            overflow: "auto",
            display: "grid",
            "grid-template-columns": "repeat(3, 360px)",
            "align-content": "start",
            gap: "24px",
            padding: "24px",
            background: "var(--bg-base)",
            color: "var(--fg-base)",
          }}
        >
          <div data-snap="side-effect">
            <Turn message={sideEffect} parts={[text(sideEffect.id), bashTool(sideEffect.id), notice(sideEffect.id)]} />
          </div>
          <div data-snap="read-only">
            <Turn message={readOnly} parts={[searchText(readOnly.id), grepTool(readOnly.id), notice(readOnly.id)]} />
          </div>
          <div data-snap="default">
            <Turn message={reply} parts={[text(reply.id), notice(reply.id)]} />
          </div>
        </div>
      </DialogProvider>
    </I18nProvider>
  )
}

export function mountRecoveryPresentationSnapFixture(root: HTMLElement) {
  render(() => <RecoveryPresentationSnapFixture />, root)
}
