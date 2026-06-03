import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, on, Component, For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { DEFAULT_PROMPT, Prompt, usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { DockSegmentForm } from "@opencode-ai/ui/dock-card"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openModelPicker } from "@/components/prompt-input/model-picker"
import { useCommand } from "@/context/command"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { setCursorPosition } from "./prompt-input/editor-dom"
import { createEditorImperatives } from "./prompt-input/editor-imperatives"
import { createCommentRouting } from "./prompt-input/comment-routing"
import { createHistoryNavigation } from "./prompt-input/history-navigation"
import { createEditorInput } from "./prompt-input/editor-input"
import {
  createPopoverControllers,
  type PopoverControllers,
} from "./prompt-input/popover-controllers"
import { createPromptKeydownHandler } from "./prompt-input/keydown"
import { PromptActionBar } from "./prompt-input/action-bar"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import { promptLength } from "./prompt-input/history"
import { createPromptDerivedState } from "./prompt-input/derived-state"
import { createPromptCommandsAndMode } from "./prompt-input/commands-mode"
import { createEditLoadEffect } from "./prompt-input/edit-load-effect"
import type { PromptStore } from "./prompt-input/store-types"
import type { FollowupDraft } from "./prompt-input/followup-draft"
import { createPromptSubmit } from "./prompt-input/submit"
import { PromptPopover } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { ImagePreview } from "@opencode-ai/ui/image-preview"

interface PromptInputProps {
  class?: string
  ref?: (el: HTMLDivElement) => void
  homeMode?: boolean
  newSessionWorktree?: string
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  sessionID?: string
  sessionIDControlled?: boolean
  actionReady?: () => boolean
  abortReady?: () => boolean
}

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const comments = useComments()
  const dialog = useDialog()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const { params } = useSessionLayout()
  const activeSessionID = createMemo(() => (props.sessionIDControlled ? props.sessionID : params.id))
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56
  const space = `${inset}px`

  const {
    queueScroll,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    restoreFocus,
    renderEditorWithCursor,
    getCaretState,
    escBlur,
  } = createEditorImperatives({
    editorRef: () => editorRef,
    scrollRef: () => scrollRef,
    prompt,
    platform,
    inset,
  })

  const { recent, openComment } = createCommentRouting({ activeSessionID })

  const [store, setStore] = createStore<PromptStore>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const {
    info,
    working,
    imageAttachments,
    actionReady,
    abortReady,
    commentCount,
    blank,
    stopping,
    contextItems,
    placeholder,
    accepting,
  } = createPromptDerivedState({
    store,
    prompt,
    sync,
    sdk,
    permission,
    language,
    activeSessionID,
    actionReadyProp: () => props.actionReady?.(),
    abortReadyProp: () => props.abortReady?.(),
  })

  const { addToHistory, navigateHistory } = createHistoryNavigation({
    store,
    setStore,
    prompt,
    comments,
    editorRef: () => editorRef,
    queueScroll,
  })

  createEffect(
    on(
      () => store.mode,
      (mode) => props.onModeChange?.(mode),
      { defer: true },
    ),
  )

  const { pick } = createPromptCommandsAndMode({
    command,
    language,
    platform,
    store,
    setStore,
    actionReady,
    addPickedPaths: () => addPickedPaths,
    editorRef: () => editorRef,
    fallbackInputClick: () => fileInputRef?.click(),
  })

  const closePopover = () => setStore("popover", null)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  let popoversRef: PopoverControllers | null = null
  const popoversAccess = () => {
    if (!popoversRef) throw new Error("popoversRef accessed before initialization")
    return popoversRef
  }

  const editorInput = createEditorInput({
    store,
    setStore,
    prompt,
    sdk,
    sync,
    imageAttachments,
    editorRef: () => editorRef,
    mirror,
    imperatives: { queueScroll, renderEditorWithCursor },
    popovers: popoversAccess,
    closePopover,
    resetHistoryNavigation,
  })

  const popovers = createPopoverControllers({
    store,
    setStore,
    prompt,
    command,
    sync,
    files,
    language,
    recent,
    imageAttachments,
    actionReady,
    slashPopoverRef: () => slashPopoverRef,
    addPart: editorInput.addPart,
    closePopover,
    clearEditor,
    setEditorText,
    focusEditorEnd,
    renderEditorWithCursor,
  })
  popoversRef = popovers

  const {
    atFlat,
    atActive,
    setAtActive,
    atOnKeyDown,
    atKey,
    handleAtSelect,
    slashFlat,
    slashActive,
    setSlashActive,
    slashOnKeyDown,
    handleSlashSelect,
    selectPopoverActive,
  } = popovers
  const {
    composing,
    isImeComposing,
    handleBlur,
    handleCompositionStart,
    handleCompositionEnd,
    handleInput,
    handleCopy,
    addPart,
  } = editorInput

  createEditLoadEffect({
    prompt,
    setStore,
    editorRef: () => editorRef,
    queueScroll,
    editDraft: () => props.edit,
    onEditLoaded: () => props.onEditLoaded?.(),
  })

  const { addAttachments, addPickedPaths, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    model: () => local.model.current(),
    openModelSelector: () => {
      openModelPicker()
    },
    readFileDataUrl: platform.readFileDataUrl,
    readClipboardImage: platform.readClipboardImage,
    // Path C dependencies (paste of `/<known-name> args` into empty input).
    imageAttachments,
    composing,
    sync,
    externalReady: actionReady,
  })

  const navigate = useNavigate()
  const routeParams = useParams()

  const { abort, handleSubmit } = createPromptSubmit({
    sessionID: activeSessionID,
    isNewSession: () => props.homeMode === true || (!props.sessionIDControlled && !activeSessionID()),
    info,
    imageAttachments,
    commentCount,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working,
    actionReady,
    abortReady,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
    navigate,
    routeParams: () => routeParams,
  })

  createEffect(() => {
    if (actionReady()) return
    closePopover()
    setStore("draggingType", null)
  })

  const handleKeyDown = createPromptKeydownHandler({
    store,
    setStore,
    editorRef: () => editorRef,
    prompt,
    working,
    stopping,
    actionReady,
    abortReady,
    selectPopoverActive,
    atOnKeyDown,
    slashOnKeyDown,
    closePopover,
    getCaretState,
    escBlur,
    addPart,
    isImeComposing,
    navigateHistory,
    pick,
    abort,
    handleSubmit,
  })

  return (
    <div class="relative size-full _max-h-[320px] flex flex-col gap-0">
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <DockSegmentForm
        onSubmit={handleSubmit}
        classList={{
          "group/prompt-input @container/composer": true,
          "border-fg-base border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={contextItems()}
          active={(item) => {
            const active = comments.active()
            return !!item.commentID && item.commentID === active?.id && item.path === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.path, item.commentID)
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
          sourceFilesystemDirectory={sdk.directory}
        />
        <PromptImageAttachments
          attachments={imageAttachments()}
          onOpen={(attachment) =>
            dialog.show(() => <ImagePreview src={attachment.dataUrl} alt={attachment.filename} />)
          }
          onRemove={removeAttachment}
          removeLabel={language.t("prompt.attachment.remove")}
        />
        <div
          class="relative overflow-hidden rounded-b-[var(--radius-lg)]"
          onMouseDown={(e) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            // exempt all chip / action controls in the bar so clicking them
            // doesn't steal focus back to the editor before the popover opens
            if (target.closest("[data-action], button, [role='button']")) {
              return
            }
            editorRef?.focus()
          }}
        >
          <div
            class="relative min-h-[100px] max-h-[240px] overflow-y-auto no-scrollbar"
            ref={(el) => (scrollRef = el)}
            style={{ "scroll-padding-bottom": space }}
          >
            <div
              data-component="prompt-input"
              ref={(el) => {
                editorRef = el
                props.ref?.(el)
              }}
              role="textbox"
              aria-multiline="true"
              aria-label={placeholder()}
              contenteditable="true"
              autocapitalize={store.mode === "normal" ? "sentences" : "off"}
              autocorrect={store.mode === "normal" ? "on" : "off"}
              spellcheck={store.mode === "normal"}
              inputMode="text"
              // @ts-expect-error
              autocomplete="off"
              onInput={handleInput}
              onCopy={handleCopy}
              onPaste={(event) => {
                const hasFiles = Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === "file")
                if (!actionReady() && hasFiles) {
                  event.preventDefault()
                  return
                }
                handlePaste(event)
              }}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              classList={{
                "select-text": true,
                "w-full pl-4 pr-4 pt-4 text-body text-fg-strong focus:outline-none whitespace-pre-wrap": true,
                "[&_[data-type=file]]:text-syntax-property": true,
                "[&_[data-type=agent]]:text-syntax-type": true,
                "font-mono!": store.mode === "shell",
              }}
              style={{ "padding-bottom": space }}
            />
            <Show when={!prompt.dirty()}>
              <div
                data-component="prompt-placeholder"
                class="absolute top-0 inset-x-0 pl-4 pr-4 pt-4 text-body text-fg-weak pointer-events-none whitespace-nowrap truncate"
                classList={{ "font-mono!": store.mode === "shell" }}
                style={{ "padding-bottom": space }}
              >
                {placeholder()}
              </div>
            </Show>
          </div>

          <div
            aria-hidden="true"
            class="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              height: space,
              background:
                "linear-gradient(to top, var(--surface-raised) calc(100% - 20px), transparent)",
            }}
          />

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_FILE_TYPES.join(",")}
            class="hidden"
            onChange={(e) => {
              const list = e.currentTarget.files
              if (list && actionReady()) void addAttachments(Array.from(list))
              e.currentTarget.value = ""
            }}
          />

          <PromptActionBar
            mode={store.mode}
            homeMode={props.homeMode}
            language={language}
            command={command}
            model={local.model}
            actionReady={actionReady}
            working={working}
            abortReady={abortReady}
            blank={blank}
            stopping={stopping}
            pick={pick}
            restoreFocus={restoreFocus}
          />
        </div>
      </DockSegmentForm>
    </div>
  )
}
