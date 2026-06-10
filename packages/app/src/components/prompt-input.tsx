import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, on, Component, For, createMemo, createSignal } from "solid-js"
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
import { PromptEditorSurface } from "./prompt-input/editor-surface"
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
import { showAttachmentInFolder } from "./prompt-input/attachment-reveal"

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
    filePathForBrowserFile: platform.filePathForBrowserFile,
    saveAttachmentFile: platform.saveAttachmentFile,
    statPaths: platform.statPaths,
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
            const commentPath = item.commentPath ?? item.path
            return !!item.commentID && item.commentID === active?.id && commentPath === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.commentPath ?? item.path, item.commentID)
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
          <PromptEditorSurface
            setScrollRef={(el) => (scrollRef = el)}
            setEditorRef={(el) => {
              editorRef = el
              props.ref?.(el)
            }}
            setFileInputRef={(el) => (fileInputRef = el)}
            mode={store.mode}
            placeholder={placeholder}
            dirty={prompt.dirty}
            space={space}
            actionReady={actionReady}
            onInput={handleInput}
            onCopy={handleCopy}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            handlePaste={handlePaste}
            addAttachments={addAttachments}
            onFileAttachmentOpen={(path) => {
              showAttachmentInFolder({ platform, directory: sdk.directory, path })
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
