import { For, Show, createMemo, createSignal } from "solid-js"
import type { FilePart, UserMessage, Part, TextPart } from "@opencode-ai/sdk/v2"
import { AttachmentChip } from "./attachment-chip"
import { Icon } from "./icon"
import "./session-turn-user-bubble.css"

/**
 * Slice 11b.1 user bubble — the new visual surface DESIGN.md L453-L462
 * locks: cream `--bg-cream` fill, `--radius-lg` 14, right-aligned content-
 * hugging body with `max-width: 75%`, attachment row floating above the
 * bubble in a separate flex row, and a hover-only bottom toolbar split
 * into a meta segment (model + time) and an actions segment ([Copy]
 * [Reset]).
 *
 * The component is presentational — it does not call the SDK directly.
 * The shell wires real `sdk.client.session.revert` / clipboard / model
 * resolution through the `actions` and `modelName` props. The bubble
 * owns local UI state only (copy-success flash, reset busy guard).
 *
 * a11y posture (§6.18 / DESIGN.md L461):
 * - Toolbar is always mounted; visibility is CSS-only via opacity +
 *   pointer-events. `:focus-within` is added next to `:hover` so
 *   keyboard-only users can still surface the toolbar by tabbing into
 *   one of its buttons.
 * - Reset enters the existing iconbtn disabled state during in-flight
 *   SDK calls (§6.14 rapid-click guard).
 */

export interface SessionTurnUserBubbleActions {
  /** Override the built-in `navigator.clipboard.writeText` path. */
  onCopy?: (text: string) => Promise<void> | void
  /** Caller-owned reset entry point. When undefined, the [Reset] button is hidden. */
  onReset?: () => Promise<void> | void
}

export interface SessionTurnUserBubbleProps {
  message: UserMessage
  parts: readonly Part[]
  /** Resolved display name for the model the agent used for this round. */
  modelName?: string
  /** Locale for the `HH:mm` time formatter. Defaults to the browser locale. */
  locale?: string
  /** i18n-resolved strings. Required so the bubble stays free of context coupling. */
  labels: {
    copy: string
    copied: string
    reset: string
  }
  actions?: SessionTurnUserBubbleActions
}

function isImagePart(part: FilePart): boolean {
  return typeof part.mime === "string" && part.mime.startsWith("image/")
}

function defaultExtFromFilename(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  const dot = filename.lastIndexOf(".")
  if (dot < 0 || dot === filename.length - 1) return undefined
  return filename.slice(dot + 1)
}

export function SessionTurnUserBubble(props: SessionTurnUserBubbleProps) {
  const [copied, setCopied] = createSignal(false)
  const [resetting, setResetting] = createSignal(false)

  // Multiple non-synthetic text parts are joined with a double newline so
  // paragraph boundaries between two parts survive (design doc §3.3). The
  // bubble renders plain text via JSX `{value}` interpolation, so
  // `white-space: pre-wrap` in the CSS is required for `\n\n` to render.
  const textParts = createMemo(() =>
    props.parts.filter((p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic),
  )
  const bubbleText = createMemo(() => textParts().map((p) => p.text ?? "").join("\n\n"))

  const fileParts = createMemo(() => props.parts.filter((p): p is FilePart => p.type === "file"))

  const timeStamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return undefined
    return new Intl.DateTimeFormat(props.locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(created)
  })

  const timeTitle = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return undefined
    return new Date(created).toString()
  })

  const handleCopy = async () => {
    const text = bubbleText()
    if (!text) return
    try {
      if (props.actions?.onCopy) {
        await props.actions.onCopy(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // §6.13: clipboard failure surfaces via the caller's `onCopy` toast
      // path. When using the built-in fallback we swallow silently;
      // a hosted toast handler is wired through `actions.onCopy` in
      // production callers.
    }
  }

  const handleReset = async () => {
    if (resetting() || !props.actions?.onReset) return
    setResetting(true)
    try {
      await props.actions.onReset()
    } finally {
      setResetting(false)
    }
  }

  return (
    <div data-component="session-turn-user-bubble">
      <Show when={fileParts().length > 0}>
        <div data-slot="bubble-attachment-row">
          <For each={fileParts()}>
            {(file) => (
              <AttachmentChip
                kind={isImagePart(file) ? "image" : "file"}
                name={file.filename}
                ext={defaultExtFromFilename(file.filename)}
                previewUrl={isImagePart(file) ? file.url : undefined}
                alt={file.filename}
                removable={false}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={bubbleText()}>
        <div data-slot="bubble">
          <div data-slot="bubble-text">{bubbleText()}</div>
        </div>
      </Show>
      <div data-slot="bubble-toolbar">
        <Show when={props.modelName || timeStamp()}>
          <div data-slot="bubble-toolbar-meta">
            <Show when={props.modelName}>
              <span data-slot="bubble-toolbar-model">{props.modelName}</span>
            </Show>
            <Show when={timeStamp()}>
              <span data-slot="bubble-toolbar-time" title={timeTitle()}>
                {timeStamp()}
              </span>
            </Show>
          </div>
        </Show>
        <div data-slot="bubble-toolbar-actions">
          {/* Reset sits left of copy so the toolbar reads model · time · reset · copy
              with copy on the rightmost slot per AstroHan W1 review feedback. */}
          <Show when={props.actions?.onReset}>
            <button
              type="button"
              data-slot="bubble-toolbar-action"
              data-action="reset"
              disabled={resetting()}
              aria-disabled={resetting() || undefined}
              aria-label={props.labels.reset}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void handleReset()}
            >
              <Icon name="reset" />
            </button>
          </Show>
          <button
            type="button"
            data-slot="bubble-toolbar-action"
            data-action="copy"
            data-copied={copied() || undefined}
            aria-label={copied() ? props.labels.copied : props.labels.copy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void handleCopy()}
          >
            <Icon name={copied() ? "check" : "copy"} />
          </button>
        </div>
      </div>
    </div>
  )
}
