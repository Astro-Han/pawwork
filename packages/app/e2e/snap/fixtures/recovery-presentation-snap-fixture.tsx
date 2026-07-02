import { render } from "solid-js/web"
import type { AssistantMessage, NoticePart, TextPart, ToolPart } from "@opencode-ai/sdk/v2"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { dict as en } from "@opencode-ai/ui/i18n/en"
import { AssistantParts } from "@opencode-ai/ui/message-part"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

// The #1358 terminal notice through the real pipeline (AssistantParts →
// tool.tsx card + notice.tsx), in the REAL cross-message topology: a
// side-effecting tool completes in one assistant message, and the trailing
// safe_retry_failed notice lands on the NEXT assistant message of the same turn
// (the post-tool continuation runs as a new message). The notice now carries the
// backend `sideEffect` flag, so the UI reads the field instead of scanning its
// own message. Three scenarios × two languages (中英对照).
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

function text(messageID: string, body: string): TextPart {
  return { id: `${messageID}_text`, sessionID: SESSION, messageID, type: "text", text: body, time: { start: 0, end: 1 } }
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
      input: { command: 'gh issue comment 1358 --body "已按方案排期。"', description: "在 #1358 下留言" },
      output: "https://github.com/Astro-Han/pawwork/issues/1358#issuecomment-3920481",
      title: "在 #1358 下留言",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  }
}

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

// `sideEffect` is what the backend writes: true when a side-effecting tool
// completed earlier in the turn (bash here), false for read-only / no tool.
function notice(messageID: string, sideEffect: boolean): NoticePart {
  return { id: `${messageID}_notice`, sessionID: SESSION, messageID, type: "notice", kind: "safe_retry_failed", sideEffect, time: { created: 1 } }
}

function makeI18n(dict: Record<string, string>) {
  return {
    locale: () => "x",
    t: (key: UiI18nKey, params?: UiI18nParams) => {
      const template = dict[key] ?? en[key] ?? String(key)
      return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => String(params?.[String(rawKey)] ?? ""))
    },
  }
}

type MsgParts = { message: AssistantMessage; parts: (TextPart | ToolPart | NoticePart)[] }

// AssistantParts renders each message's parts in order, so a two-message turn
// shows the tool card (message A) above the notice (message B) — the real split.
function Turn(props: { messages: MsgParts[] }) {
  const store = {
    message: {},
    part: Object.fromEntries(props.messages.map((m) => [m.message.id, m.parts])),
  }
  return (
    <MarkedProvider>
      <DataProvider data={store} directory="/Users/yuhan/PawWork">
        <AssistantParts messages={props.messages.map((m) => m.message)} />
      </DataProvider>
    </MarkedProvider>
  )
}

// Scenarios built fresh per band so each language's Turn gets an isolated store.
function sideEffectTurn(): MsgParts[] {
  const a = assistant("msg_se_a")
  const b = assistant("msg_se_b")
  return [
    { message: a, parts: [text(a.id, "我帮你在 issue #1358 下留了一条评论。"), bashTool(a.id)] },
    { message: b, parts: [notice(b.id, true)] },
  ]
}
function readOnlyTurn(): MsgParts[] {
  const a = assistant("msg_ro_a")
  const b = assistant("msg_ro_b")
  return [
    { message: a, parts: [text(a.id, "我先在代码里查了下相关实现。"), grepTool(a.id)] },
    { message: b, parts: [notice(b.id, false)] },
  ]
}
function noToolTurn(): MsgParts[] {
  const b = assistant("msg_nt_b")
  return [{ message: b, parts: [notice(b.id, false)] }]
}

function Band(props: { dict: Record<string, string>; label: string }) {
  return (
    <I18nProvider value={makeI18n(props.dict)}>
      <div data-lang={props.label} style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
        <div style={{ "font-size": "12px", "font-weight": "600", color: "var(--fg-weak)", "letter-spacing": "0.04em" }}>
          {props.label}
        </div>
        <div style={{ display: "grid", "grid-template-columns": "repeat(3, 360px)", gap: "24px", "align-items": "start" }}>
          <div data-snap="side-effect">
            <Turn messages={sideEffectTurn()} />
          </div>
          <div data-snap="read-only">
            <Turn messages={readOnlyTurn()} />
          </div>
          <div data-snap="default">
            <Turn messages={noToolTurn()} />
          </div>
        </div>
      </div>
    </I18nProvider>
  )
}

function RecoveryPresentationSnapFixture() {
  return (
    <DialogProvider>
      {/* Opaque full-viewport cover at max z-index so the app's dev chrome
          (debug bar, server-health toast) renders behind the captured grid. */}
      <div
        style={{
          position: "fixed",
          inset: "0",
          "z-index": "2147483647",
          overflow: "auto",
          display: "flex",
          "flex-direction": "column",
          gap: "28px",
          padding: "24px",
          background: "var(--bg-base)",
          color: "var(--fg-base)",
        }}
      >
        <Band dict={zh} label="中文" />
        <Band dict={en} label="English" />
      </div>
    </DialogProvider>
  )
}

export function mountRecoveryPresentationSnapFixture(root: HTMLElement) {
  render(() => <RecoveryPresentationSnapFixture />, root)
}
