import { Component, For, Show, createResource } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { FloatingAttachment } from "@/context/prompt"
import { attachmentChipModel, type AttachmentChipModel } from "./attachment-chips-model"

type PromptAttachmentChipsProps = {
  attachments: FloatingAttachment[]
  onOpenImage: (image: { src: string; alt: string }) => void
  onReveal: (path: string) => void
  onRemove: (id: string) => void
  /** Reads a path-backed image as a data URL for thumbnail display only. */
  loadPreview?: (path: string, mime: string) => Promise<string | null>
  removeLabel: string
  revealLabel: string
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

const FileChipBody: Component<{ model: AttachmentChipModel; revealLabel: string; onReveal: (path: string) => void }> = (
  props,
) => (
  <button
    type="button"
    onClick={() => props.model.path && props.onReveal(props.model.path)}
    title={props.model.path ? props.revealLabel : undefined}
    class="h-14 max-w-60 rounded-md border border-border-base bg-surface-base flex items-center gap-2.5 pl-3 pr-4 text-left"
  >
    <FileIcon node={{ path: props.model.filename, type: "file" }} class="size-6 shrink-0" />
    <span class="flex min-w-0 flex-col leading-snug">
      <span class="text-body text-fg-strong truncate">{props.model.filename}</span>
      <Show when={props.model.sizeText}>
        <span class="font-mono text-[12px] text-fg-weak tabular-nums">{props.model.sizeText}</span>
      </Show>
    </span>
  </button>
)

const ImageChip: Component<{
  model: AttachmentChipModel
  loadPreview?: (path: string, mime: string) => Promise<string | null>
  onOpenImage: (image: { src: string; alt: string }) => void
  revealLabel: string
  onReveal: (path: string) => void
}> = (props) => {
  const [preview] = createResource(
    () => (props.model.legacyDataUrl ? undefined : props.model.path),
    async (path) => (await props.loadPreview?.(path, props.model.mime ?? "image/png")) ?? null,
  )
  const src = () => props.model.legacyDataUrl ?? preview() ?? undefined

  return (
    <Show
      when={src()}
      fallback={<FileChipBody model={props.model} revealLabel={props.revealLabel} onReveal={props.onReveal} />}
    >
      <img
        src={src()}
        alt={props.model.filename}
        onClick={() => props.onOpenImage({ src: src()!, alt: props.model.filename })}
        class="size-14 rounded-md object-cover border border-border-base cursor-pointer"
      />
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
            return (
              <Tooltip value={model.tooltip} placement="top" contentClass="break-all whitespace-pre-line">
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
                </div>
              </Tooltip>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
