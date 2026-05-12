import "./session-turn-event.css"

/**
 * Slice 11b.1 system event line — a single muted caption that hugs the
 * timeline column flush with agent prose, signalling round-level state
 * changes (interrupt, connection lost, connection restored).
 *
 * 11b.1 wires only the `interrupted` kind via `assistantMessage.error?.name
 * === "MessageAbortedError"`. The `connection-lost` / `connection-restored`
 * kinds reserve the W1 taxonomy so the right-pane work in 11b.2 (or a
 * sync-layer follow-up) can light them up without changing this
 * component's public API.
 *
 * The component is context-free: it accepts an already-resolved label so
 * the shell decides the i18n string. Placement (after the last rendered
 * assistant part, before the next user message) is enforced by the
 * SessionTurn agent round, not here — `SystemEvent` is one DOM element
 * with no implied position.
 */

export type SystemEventKind = "interrupted" | "connection-lost" | "connection-restored"

export interface SystemEventProps {
  kind: SystemEventKind
  /**
   * i18n-resolved label. The caller picks the string for the kind it
   * passes; the component does no lookup so it stays free of i18n
   * context coupling and is trivial to unit-test.
   */
  label: string
}

export function SystemEvent(props: SystemEventProps) {
  return (
    <div data-component="session-turn-event" data-kind={props.kind}>
      {props.label}
    </div>
  )
}
