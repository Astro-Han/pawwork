// Per-kind presentation for the session error card. The canonical discriminant
// is `providerFailure.kind` (provider/error.ts), already carried on the SDK
// payload (ApiError.data.providerFailure.kind) and set for every kind including
// the stream failures transport_disconnect / decompression (message-v2.ts). This
// turns that kind into the card's severity, title/body copy keys, and optional
// action. The raw provider reason itself comes from `decodeServerErrorText`; this
// file owns only the typed presentation, never invented copy.
//
// Folded-in scope: the free-quota upsell stays its own RateLimitCard (a retry
// classification, not a providerFailure.kind) and already shares the Card
// primitive, so it reads as the same family without sharing this code path.

import type { ApiError } from "@opencode-ai/sdk/v2/client"

export type ErrorCardKind = NonNullable<NonNullable<ApiError["data"]["providerFailure"]>["kind"]>

export interface ErrorCardPresentation {
  kind: ErrorCardKind
  /** Drives the card's 2px left rule + icon: red = must act, amber = wait / resend. */
  severity: "error" | "warning"
  titleKey: string
  /** Plain-language body key; absent for `unknown`, whose body is the decoded reason. */
  bodyKey?: string
  /** `unknown` has no plain copy — show the decoded provider reason as the body. */
  rawBody: boolean
  /** Only the must-act kinds offer an action; all route to the models settings tab. */
  action?: { labelKey: string; target: "models" }
}

// One per-kind table, mirrored from the SDK union. `satisfies Record<…>` makes
// adding a kind to the SDK a compile error here until it is classified: severity
// drives the 2px rule + icon (error = red / must act, warning = amber / wait),
// and `action` flags the must-act kinds that offer a single primary button — all
// routing to the models settings tab (re-enter credentials / pick a different
// model). There is deliberately no one-click retry: wait kinds resolve on their
// own or by the user resending.
const PRESENTATION = {
  auth: { severity: "error", action: true },
  quota_exhausted: { severity: "error", action: true },
  invalid_request: { severity: "error", action: true },
  rate_limit: { severity: "warning" },
  server_overload: { severity: "warning" },
  transport_disconnect: { severity: "warning" },
  decompression: { severity: "warning" },
  unknown: { severity: "warning" },
} satisfies Record<ErrorCardKind, { severity: "error" | "warning"; action?: true }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function providerFailureKind(error: Record<string, unknown>): ErrorCardKind | undefined {
  const data = isRecord(error.data) ? error.data : undefined
  const failure = data && isRecord(data.providerFailure) ? data.providerFailure : undefined
  const kind = failure && typeof failure.kind === "string" ? failure.kind : undefined
  // `Object.hasOwn`, not `in`: a payload with kind "constructor" / "__proto__"
  // would otherwise pass the `in` check (inherited prototype keys) and bypass the
  // unknown fallback, rendering a garbage `ui.errorCard.constructor.title` key.
  return kind && Object.hasOwn(PRESENTATION, kind) ? (kind as ErrorCardKind) : undefined
}

// Build the card presentation for a server / assistant error payload. Returns
// undefined for anything that is not a recognizable error payload (callers keep
// their own default). An error payload without a usable `providerFailure.kind`
// (or with an unrecognized one) falls back to `unknown`, which surfaces the
// decoded provider reason rather than guessing a category.
export function errorCardPresentation(error: unknown): ErrorCardPresentation | undefined {
  if (!isRecord(error) || !isRecord(error.data)) return undefined
  const kind = providerFailureKind(error) ?? "unknown"
  const entry = PRESENTATION[kind]
  const rawBody = kind === "unknown"
  return {
    kind,
    severity: entry.severity,
    titleKey: `ui.errorCard.${kind}.title`,
    bodyKey: rawBody ? undefined : `ui.errorCard.${kind}.body`,
    rawBody,
    action: "action" in entry ? { labelKey: `ui.errorCard.${kind}.action`, target: "models" } : undefined,
  }
}
