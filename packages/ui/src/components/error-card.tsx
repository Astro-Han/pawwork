import { Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { errorCardPresentation } from "../util/error-card"
import { decodeServerErrorText } from "../util/server-error"
import { Button } from "./button"
import { Card, CardActions, CardDescription, CardTitle } from "./card"
import { Collapsible } from "./collapsible"
import "./error-card.css"

export interface ErrorCardProps {
  /** The assistant / server error payload (an ApiError or other NamedError). */
  error: unknown
  /**
   * App-injected side effect for the card's primary action. Lives in the app
   * layer (like RateLimitCardWiring) so packages/ui stays framework-agnostic.
   * Today the only target is the models settings tab (re-login / switch model).
   */
  onAction?: (target: "models") => void
}

// The session error card: one shell for every provider failure, keyed by
// `providerFailure.kind`. Severity drives the 2px rule + icon (red = must act,
// amber = wait / resend); plain copy is the body and the provider's real reason
// sits in a collapsed "detail". `unknown` has no plain copy, so the decoded
// reason becomes the body and there is no separate detail.
export function ErrorCard(props: ErrorCardProps) {
  const i18n = useI18n()
  const presentation = () => errorCardPresentation(props.error)
  const reason = () => decodeServerErrorText(props.error)
  const variant = () => presentation()?.severity ?? "error"
  const title = () => i18n.t(presentation()?.titleKey ?? "ui.errorCard.unknown.title")
  // True when the body is the provider's raw reason (unknown / no plain copy)
  // rather than short localized copy — that text is unbounded, so it gets capped.
  const rawBody = () => {
    const current = presentation()
    return !current || current.rawBody || !current.bodyKey
  }
  const body = () => {
    const current = presentation()
    if (rawBody() || !current?.bodyKey) return reason() ?? ""
    return i18n.t(current.bodyKey)
  }
  // The detail carries the provider's verbatim reason beneath the plain copy.
  // Skipped for rawBody kinds, where the reason already is the body.
  const detail = () => {
    const current = presentation()
    if (current?.rawBody !== false) return undefined
    return reason()
  }
  const action = () => presentation()?.action

  return (
    <Card variant={variant()} data-kind="error-card" class="error-card">
      <CardTitle variant={variant()}>{title()}</CardTitle>
      <Show when={body()}>
        {(value) => <CardDescription class={rawBody() ? "error-card__raw" : undefined}>{value()}</CardDescription>}
      </Show>
      <Show when={action()}>
        {(current) => (
          <CardActions>
            <Button
              variant="primary"
              data-slot="error-card-action"
              onClick={() => props.onAction?.(current().target)}
            >
              {i18n.t(current().labelKey)}
            </Button>
          </CardActions>
        )}
      </Show>
      <Show when={detail()}>
        {(value) => (
          <Collapsible variant="ghost" class="error-card__detail">
            <Collapsible.Trigger>
              <span data-slot="error-card-detail-label">{i18n.t("ui.errorCard.detail")}</span>
              <Collapsible.Arrow />
            </Collapsible.Trigger>
            <Collapsible.Content>
              <div data-slot="error-card-reason">{value()}</div>
            </Collapsible.Content>
          </Collapsible>
        )}
      </Show>
    </Card>
  )
}
