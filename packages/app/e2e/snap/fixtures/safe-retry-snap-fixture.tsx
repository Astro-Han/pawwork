import { render } from "solid-js/web"
import type { AssistantMessage, NoticePart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import { AssistantParts } from "@opencode-ai/ui/message-part"
import { SessionRetry } from "@opencode-ai/ui/session-retry"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

const assistant: AssistantMessage = {
  id: "msg_safe_retry_assistant",
  role: "assistant",
  sessionID: "ses_safe_retry",
  parentID: "msg_safe_retry_user",
  modelID: "test-model",
  providerID: "test-provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/Users/yuhan/PawWork", root: "/Users/yuhan/PawWork" },
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
  time: {
    created: 0,
    completed: 1,
  },
}

// A preceding reasoning part reproduces the #943 scenario: the terminal notice
// follows a reasoning trow and must read as its own status line, not as a
// trailing thought attached to the thinking block.
const reasoning: ReasoningPart = {
  id: "part_safe_retry_reasoning",
  sessionID: assistant.sessionID,
  messageID: assistant.id,
  type: "reasoning",
  text: "正在分析请求并准备调用工具继续。",
  time: { start: 0, end: 1 },
}

const notice: NoticePart = {
  id: "part_safe_retry_failed",
  sessionID: assistant.sessionID,
  messageID: assistant.id,
  type: "notice",
  kind: "safe_retry_failed",
  time: { created: 1 },
}

const i18n = {
  locale: () => "zh",
  t: (key: UiI18nKey, params?: UiI18nParams) => {
    const template = zh[key] ?? String(key)
    return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => String(params?.[String(rawKey)] ?? ""))
  },
}

function SafeRetrySnapFixture() {
  return (
    <I18nProvider value={i18n}>
      <div
        style={{
          display: "grid",
          gap: "20px",
          padding: "24px",
          background: "var(--bg-base)",
          color: "var(--fg-base)",
          width: "520px",
        }}
      >
        <div data-snap="running">
          <SessionRetry
            status={{
              type: "retry",
              attempt: 1,
              message: "",
              next: Date.now() + 1000,
              presentation: "recovery",
              reason: "network_connection_dropped",
            }}
          />
        </div>
        {/* Mirror the real assistant-content container (flex column, 12px gap)
            so the captured spacing above the notice divider matches production. */}
        <div data-snap="notice" style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
          <MarkedProvider>
            <DataProvider
              data={{ message: {}, part: { [assistant.id]: [reasoning, notice] } }}
              directory="/Users/yuhan/PawWork"
            >
              <AssistantParts messages={[assistant]} />
            </DataProvider>
          </MarkedProvider>
        </div>
        {/* A notice that is the turn's only part (first-attempt connection
            failure, reasoning removed) must NOT draw a leading divider. */}
        <div data-snap="notice-standalone" style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
          <MarkedProvider>
            <DataProvider
              data={{ message: {}, part: { [assistant.id]: [notice] } }}
              directory="/Users/yuhan/PawWork"
            >
              <AssistantParts messages={[assistant]} />
            </DataProvider>
          </MarkedProvider>
        </div>
      </div>
    </I18nProvider>
  )
}

export function mountSafeRetrySnapFixture(root: HTMLElement) {
  render(() => <SafeRetrySnapFixture />, root)
}
