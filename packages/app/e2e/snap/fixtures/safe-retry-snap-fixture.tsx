import { render } from "solid-js/web"
import type { AssistantMessage, NoticePart } from "@opencode-ai/sdk/v2"
import { DataProvider, I18nProvider } from "@opencode-ai/ui/context"
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
              presentation: "safe_recovery",
              reason: "network_connection_dropped",
            }}
          />
        </div>
        <div data-snap="notice">
          <DataProvider data={{ message: {}, part: { [assistant.id]: [notice] } }} directory="/Users/yuhan/PawWork">
            <AssistantParts messages={[assistant]} />
          </DataProvider>
        </div>
      </div>
    </I18nProvider>
  )
}

export function mountSafeRetrySnapFixture(root: HTMLElement) {
  render(() => <SafeRetrySnapFixture />, root)
}
