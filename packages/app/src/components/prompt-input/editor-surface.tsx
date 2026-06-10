// The composer's editable surface: the scrollable contenteditable region with
// its overlaid placeholder, the bottom fade gradient, and the hidden file
// input. Returns a fragment so DOM order inside the rounded container is
// unchanged. The three DOM refs are mutable and consumed by the parent, so
// they are forwarded via setter callbacks rather than owned here.

import { Show, type Accessor } from "solid-js"
import { ACCEPTED_FILE_TYPES } from "./files"
import type { PromptStore } from "./store-types"

export interface PromptEditorSurfaceProps {
  setEditorRef: (el: HTMLDivElement) => void
  setScrollRef: (el: HTMLDivElement) => void
  setFileInputRef: (el: HTMLInputElement) => void
  mode: PromptStore["mode"]
  placeholder: Accessor<string>
  dirty: Accessor<boolean>
  space: string
  actionReady: Accessor<boolean>
  onInput: (event?: InputEvent) => void
  onCopy: (event: ClipboardEvent) => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onBlur: () => void
  onKeyDown: (event: KeyboardEvent) => void
  handlePaste: (event: ClipboardEvent) => void
  addAttachments: (files: File[]) => void
  onFileAttachmentOpen?: (path: string) => void
}

export function PromptEditorSurface(props: PromptEditorSurfaceProps) {
  return (
    <>
      <div
        class="relative min-h-[100px] max-h-[240px] overflow-y-auto no-scrollbar"
        ref={props.setScrollRef}
        style={{ "scroll-padding-bottom": props.space }}
      >
        <div
          data-component="prompt-input"
          ref={props.setEditorRef}
          role="textbox"
          aria-multiline="true"
          aria-label={props.placeholder()}
          contenteditable="true"
          autocapitalize={props.mode === "normal" ? "sentences" : "off"}
          autocorrect={props.mode === "normal" ? "on" : "off"}
          spellcheck={props.mode === "normal"}
          inputMode="text"
          // @ts-expect-error
          autocomplete="off"
          onInput={props.onInput}
          onCopy={props.onCopy}
          onClick={(event) => {
            const target = event.target
            if (!(target instanceof HTMLElement)) return
            const pill = target.closest('[data-type="file"][data-path]')
            if (!(pill instanceof HTMLElement) || !pill.dataset.path) return
            event.preventDefault()
            props.onFileAttachmentOpen?.(pill.dataset.path)
          }}
          onPaste={(event) => {
            const hasFiles = Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === "file")
            if (!props.actionReady() && hasFiles) {
              event.preventDefault()
              return
            }
            props.handlePaste(event)
          }}
          onCompositionStart={props.onCompositionStart}
          onCompositionEnd={props.onCompositionEnd}
          onBlur={props.onBlur}
          onKeyDown={props.onKeyDown}
          classList={{
            "select-text": true,
            "w-full pl-4 pr-4 pt-4 text-body text-fg-strong focus:outline-none whitespace-pre-wrap": true,
            "[&_[data-type=file]]:text-syntax-property": true,
            "[&_[data-type=agent]]:text-syntax-type": true,
            "font-mono!": props.mode === "shell",
          }}
          style={{ "padding-bottom": props.space }}
        />
        <Show when={!props.dirty()}>
          <div
            data-component="prompt-placeholder"
            class="absolute top-0 inset-x-0 pl-4 pr-4 pt-4 text-body text-fg-weak pointer-events-none whitespace-nowrap truncate"
            classList={{ "font-mono!": props.mode === "shell" }}
            style={{ "padding-bottom": props.space }}
          >
            {props.placeholder()}
          </div>
        </Show>
      </div>

      <div
        aria-hidden="true"
        class="pointer-events-none absolute inset-x-0 bottom-0"
        style={{
          height: props.space,
          background: "linear-gradient(to top, var(--surface-raised) calc(100% - 20px), transparent)",
        }}
      />

      <input
        ref={props.setFileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES.join(",")}
        class="hidden"
        onChange={(e) => {
          const list = e.currentTarget.files
          if (list && props.actionReady()) void props.addAttachments(Array.from(list))
          e.currentTarget.value = ""
        }}
      />
    </>
  )
}
