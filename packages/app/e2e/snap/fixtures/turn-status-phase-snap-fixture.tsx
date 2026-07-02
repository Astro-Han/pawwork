import { render } from "solid-js/web"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { SessionRetry } from "@opencode-ai/ui/session-retry"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { dict as zh } from "@opencode-ai/ui/i18n/zh"
import type { UiI18nKey, UiI18nParams } from "@opencode-ai/ui/context/i18n"

// The #1358 turn-status split, rendered through the real components. Before the
// provider sends its first chunk the wait reads as "connecting", not "thinking";
// safe recovery names the retry attempt. SessionRetry is the production recovery
// row; TextShimmer is the production status shimmer — the same markup the turn
// uses (`session-turn-thinking` + `data-phase`).
const i18n = {
  locale: () => "zh",
  t: (key: UiI18nKey, params?: UiI18nParams) => {
    const template = zh[key] ?? String(key)
    return template.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => String(params?.[String(rawKey)] ?? ""))
  },
}

const recoveryStatus: SessionStatus = {
  type: "retry",
  attempt: 2,
  message: "",
  next: 0,
  presentation: "safe_recovery",
}

// The visible token values of `[data-slot="session-turn-thinking"]` in
// session-turn.css. Applied inline because that rule is scoped under a
// full-height `[data-component="session-turn"]` flex container that would fight
// an isolated snap tile; the shimmer itself is the real TextShimmer.
const thinkingRow = {
  display: "flex",
  "align-items": "center",
  gap: "8px",
  color: "var(--fg-weak)",
  "font-family": "var(--font-family-sans)",
  "font-size": "var(--font-size-body)",
  "font-weight": "var(--font-weight-emphasis)",
  "line-height": "20px",
}

function StatusRow(props: { phase: "connecting" | "thinking"; labelKey: UiI18nKey }) {
  return (
    <div data-slot="session-turn-thinking" data-phase={props.phase} style={thinkingRow}>
      <TextShimmer text={i18n.t(props.labelKey)} />
    </div>
  )
}

function TurnStatusPhaseSnapFixture() {
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
            "grid-template-columns": "repeat(3, 280px)",
            "align-content": "start",
            gap: "24px",
            padding: "24px",
            background: "var(--bg-base)",
            color: "var(--fg-base)",
          }}
        >
          <div data-snap="connecting">
            <StatusRow phase="connecting" labelKey="ui.sessionTurn.status.connecting" />
          </div>
          <div data-snap="thinking">
            <StatusRow phase="thinking" labelKey="ui.sessionTurn.status.thinking" />
          </div>
          <div data-snap="recovery">
            <SessionRetry status={recoveryStatus} show />
          </div>
        </div>
      </DialogProvider>
    </I18nProvider>
  )
}

export function mountTurnStatusPhaseSnapFixture(root: HTMLElement) {
  render(() => <TurnStatusPhaseSnapFixture />, root)
}
