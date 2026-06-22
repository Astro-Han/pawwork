import { render } from "solid-js/web"
import { For } from "solid-js"
import { Card } from "@opencode-ai/ui/card"
import { decodeServerErrorText } from "@opencode-ai/ui/util/server-error"

// PR3 surface: the session-turn error card now feeds `decodeServerErrorText` the
// raw server / assistant error payload instead of brace-hunting a display string.
// This fixture mounts the REAL `Card variant="error" class="error-card"` with the
// REAL decoder so we can see the decoded reason shapes wrap cleanly in the actual
// card chrome — the part of the change that unit tests can't show.
//
// Scenarios cover the text shapes the new decoder produces:
//   1. structured response body  -> "type: message" (the 402 billing bug fix)
//   2. clean verbatim message     -> passed through unchanged
//   3. embedded JSON in message   -> the real reason, not the JSON blob
//   4. long single-line reason    -> wrapping / overflow in a narrow turn column
//   5. plain fallback message     -> generic text still renders when that's all
//      the payload carries (no structured reason to surface)
//
// The decoded reason is provider text, not localized copy, so there is no
// language split here — locale would not change a single character.

type Scenario = { label: string; payload: unknown }

const SCENARIOS: Scenario[] = [
  {
    label: "402 structured body",
    payload: {
      name: "APIError",
      data: {
        message: "402 status code (no body)",
        statusCode: 402,
        responseBody: JSON.stringify({
          error: { message: "Insufficient Balance", code: "invalid_request_error", type: "unknown_error" },
        }),
      },
    },
  },
  {
    label: "clean message",
    payload: { name: "APIError", data: { message: "Insufficient Balance", statusCode: 402 } },
  },
  {
    label: "json-in-message",
    payload: { name: "UnknownError", data: { message: JSON.stringify({ error: { message: "rate limited" } }) } },
  },
  {
    label: "long reason",
    payload: {
      name: "APIError",
      data: {
        statusCode: 400,
        responseBody: JSON.stringify({
          error: {
            type: "invalid_request_error",
            message:
              "Your account does not have access to the requested model. Add the model to your plan or pick a different one, then resend the last message to continue.",
          },
        }),
      },
    },
  },
  {
    label: "plain fallback",
    payload: {
      name: "APIError",
      data: { message: "Connection lost. Please check whether the last operation completed before resending." },
    },
  },
]

function ErrorCardDecodeSnapFixture() {
  return (
    <div
      data-snap-grid="error-card-decode"
      style={{
        // Opaque full-viewport cover at max z-index so the app's dev chrome
        // can't bleed into the capture.
        position: "fixed",
        inset: "0",
        "z-index": "2147483647",
        overflow: "auto",
        display: "flex",
        "flex-direction": "column",
        gap: "16px",
        // The session turn constrains the card width; mirror that so wrapping
        // matches what the user sees.
        width: "560px",
        padding: "24px",
        background: "var(--bg-base)",
        color: "var(--fg-base)",
      }}
    >
      <For each={SCENARIOS}>
        {(scenario) => (
          <div data-snap={scenario.label} style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <div style={{ "font-size": "12px", "font-weight": "600", color: "var(--fg-weak)", "letter-spacing": "0.04em" }}>
              {scenario.label}
            </div>
            <Card variant="error" class="error-card">
              {decodeServerErrorText(scenario.payload) ?? "(no decoded text)"}
            </Card>
          </div>
        )}
      </For>
    </div>
  )
}

export function mountErrorCardDecodeSnapFixture(root: HTMLElement) {
  render(() => <ErrorCardDecodeSnapFixture />, root)
}
