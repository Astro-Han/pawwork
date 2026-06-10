import { Component, For, Show, createSignal, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { FloatingAttachment } from "@/context/prompt"
import { attachmentChipModel, type AttachmentChipModel } from "./attachment-chips-model"
import { attachmentCapabilityWarning, type ModelInputSupport } from "./attachment-routing"
import { cachedPreview, loadPreviewCached } from "./attachment-preview-cache"

type PromptAttachmentChipsProps = {
  attachments: FloatingAttachment[]
  onOpenImage: (image: { src: string; alt: string }) => void
  onReveal: (path: string) => void
  onRemove: (id: string) => void
  /** Reads a path-backed image as a data URL for thumbnail display only. */
  loadPreview?: (path: string, mime: string) => Promise<string | null>
  removeLabel: string
  revealLabel: string
  /** Current model accessor; media chips it cannot see get a warning badge. */
  model?: () => ModelInputSupport
  unsupportedImageLabel: string
  unsupportedPdfLabel: string
}

const removeButtonClass =
  "absolute -top-1.5 -right-1.5 size-[18px] rounded-full bg-surface-base border border-border-base flex items-center justify-center text-fg-weak hover:text-fg-strong"

const RemoveButton: Component<{ id: string; onRemove: (id: string) => void; label: string }> = (props) => (
  <button
    type="button"
    onClick={() => props.onRemove(props.id)}
    class={removeButtonClass}
    aria-label={props.label}
  >
    <Icon name="close" class="size-3" />
  </button>
)

const fileChipBodyClass =
  "h-14 max-w-60 rounded-md border border-border-base bg-surface-base flex items-center gap-2.5 pl-3 pr-4 text-left"

const FileChipContent: Component<{ model: AttachmentChipModel }> = (props) => (
  <>
    <FileIcon node={{ path: props.model.filename, type: "file" }} class="size-6 shrink-0" />
    <span class="flex min-w-0 flex-col leading-snug">
      <span class="text-body text-fg-strong truncate">{props.model.filename}</span>
      <Show when={props.model.sizeText}>
        <span class="font-mono text-[12px] text-fg-weak tabular-nums">{props.model.sizeText}</span>
      </Show>
    </span>
  </>
)

// Pathless legacy parts have no reveal action — render a static card, not a
// focusable button that does nothing.
const FileChipBody: Component<{ model: AttachmentChipModel; revealLabel: string; onReveal: (path: string) => void }> = (
  props,
) => (
  <Show
    when={props.model.path}
    fallback={
      <div class={fileChipBodyClass}>
        <FileChipContent model={props.model} />
      </div>
    }
  >
    {(path) => (
      <button type="button" onClick={() => props.onReveal(path())} title={props.revealLabel} class={fileChipBodyClass}>
        <FileChipContent model={props.model} />
      </button>
    )}
  </Show>
)

const ImageChip: Component<{
  model: AttachmentChipModel
  loadPreview?: (path: string, mime: string) => Promise<string | null>
  onOpenImage: (image: { src: string; alt: string }) => void
  revealLabel: string
  onReveal: (path: string) => void
}> = (props) => {
  // Deliberately NOT createResource: chips remount on every keystroke, and a
  // pending Resource read under the router-level Suspense boundary detaches the
  // whole route content, dropping editor focus. The module cache makes remounts
  // render synchronously and keeps one IPC read per path.
  const path = props.model.legacyDataUrl ? undefined : props.model.path
  const mime = props.model.mime ?? "image/png"
  const [preview, setPreview] = createSignal<string | null>(path ? (cachedPreview(path, mime) ?? null) : null)
  if (path && cachedPreview(path, mime) === undefined) {
    let disposed = false
    onCleanup(() => {
      disposed = true
    })
    void loadPreviewCached(path, mime, async (p, m) => (await props.loadPreview?.(p, m)) ?? null).then((result) => {
      if (!disposed) setPreview(result)
    })
  }
  const src = () => props.model.legacyDataUrl ?? preview() ?? undefined

  return (
    <Show
      when={src()}
      fallback={<FileChipBody model={props.model} revealLabel={props.revealLabel} onReveal={props.onReveal} />}
    >
      <button
        type="button"
        onClick={() => props.onOpenImage({ src: src()!, alt: props.model.filename })}
        class="block cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
      >
        <img src={src()} alt={props.model.filename} class="size-14 rounded-md object-cover border border-border-base" />
      </button>
    </Show>
  )
}

export const PromptAttachmentChips: Component<PromptAttachmentChipsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.attachments}>
          {(attachment) => {
            const model = attachmentChipModel(attachment)
            const warning = () => attachmentCapabilityWarning(props.model?.(), model.mime)
            const warningLabel = () =>
              warning() === "image" ? props.unsupportedImageLabel : props.unsupportedPdfLabel
            const tooltip = () => (warning() ? `${model.tooltip}\n${warningLabel()}` : model.tooltip)
            return (
              <Tooltip value={tooltip()} placement="top" contentClass="break-all whitespace-pre-line">
                <div class="relative">
                  <Show
                    when={model.kind === "image"}
                    fallback={
                      <FileChipBody model={model} revealLabel={props.revealLabel} onReveal={props.onReveal} />
                    }
                  >
                    <ImageChip
                      model={model}
                      loadPreview={props.loadPreview}
                      onOpenImage={props.onOpenImage}
                      revealLabel={props.revealLabel}
                      onReveal={props.onReveal}
                    />
                  </Show>
                  <RemoveButton id={model.id} onRemove={props.onRemove} label={props.removeLabel} />
                  <Show when={warning()}>
                    <span
                      data-slot="attachment-warning"
                      role="img"
                      aria-label={warningLabel()}
                      class="absolute -bottom-1.5 -right-1.5 size-[18px] rounded-full bg-surface-base border border-border-base flex items-center justify-center"
                    >
                      <Icon name="warning" class="size-3 text-warning" />
                    </span>
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
