import { useSpring } from "@opencode-ai/ui/motion-spring"
import { isWorkInFlightStatus } from "@opencode-ai/ui/util/session-status"
import { useNavigate, useParams } from "@solidjs/router"
import { createEffect, on, Component, For, Show, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { DEFAULT_PROMPT, Prompt, usePrompt, ImageAttachmentPart } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { DockSegmentForm } from "@opencode-ai/ui/dock-card"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { openModelPicker } from "@/components/prompt-input/model-picker"
import { WorkspaceChip } from "@/components/prompt-input/workspace-chip"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SendButton } from "./prompt-input/send-button"
import { useCommand } from "@/context/command"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { canUseNativeFilePicker, usePlatform } from "@/context/platform"
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
import { PromptModelControl } from "./prompt-input/model-controls"
import { createPromptAttachments } from "./prompt-input/attachments"
import { pickAttachments } from "./prompt-input/pick-attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import { promptLength } from "./prompt-input/history"
import type { PromptStore } from "./prompt-input/store-types"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { promptSendDisabled } from "./prompt-input/readiness"
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

  const info = createMemo(() => (activeSessionID() ? sync.session.get(activeSessionID()!) : undefined))
  const status = createMemo(
    () =>
      sync.data.session_status[activeSessionID() ?? ""] ?? {
        type: "idle",
      },
  )
  const working = createMemo(() => isWorkInFlightStatus(status()))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )
  const actionReady = createMemo(() => props.actionReady?.() ?? true)
  const abortReady = createMemo(() => props.abortReady?.() ?? actionReady())

  const [store, setStore] = createStore<PromptStore>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null,
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.95 + value * 0.05})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping() && abortReady()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-h3 text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    if (!actionReady()) return language.t("prompt.loading")

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
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

  const placeholder = createMemo(() =>
    actionReady()
      ? promptPlaceholder({
          mode: store.mode,
          commentCount: commentCount(),
          t: (key) => language.t(key as Parameters<typeof language.t>[0]),
        })
      : language.t("prompt.loading"),
  )

  const pick = () => {
    if (!actionReady()) return
    const openFilePickerDialog = platform.openFilePickerDialog
    void pickAttachments({
      openFilePickerDialog: canUseNativeFilePicker(platform) ? openFilePickerDialog : undefined,
      addPickedPaths,
      fallbackInputClick: () => fileInputRef?.click(),
    })
  }

  const setMode = (mode: "normal" | "shell") => {
    if (!actionReady()) return
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal" || !actionReady(),
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell" || !actionReady(),
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal" || !actionReady(),
      onSelect: () => setMode("normal"),
    },
  ])

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

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

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
  })

  const accepting = createMemo(() => {
    const id = activeSessionID()
    if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
    return permission.isAutoAccepting(id, sdk.directory)
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
          "opacity-75": !actionReady(),
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
              aria-disabled={!actionReady()}
              contenteditable={actionReady() ? "true" : "false"}
              autocapitalize={store.mode === "normal" ? "sentences" : "off"}
              autocorrect={store.mode === "normal" ? "on" : "off"}
              spellcheck={store.mode === "normal"}
              inputMode="text"
              // @ts-expect-error
              autocomplete="off"
              onInput={handleInput}
              onCopy={handleCopy}
              onPaste={(event) => {
                if (!actionReady()) {
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
                "cursor-wait text-fg-weak": !actionReady(),
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
              if (list) void addAttachments(Array.from(list))
              e.currentTarget.value = ""
            }}
          />

          <div class="pointer-events-none absolute inset-x-4 bottom-3 flex items-center justify-between gap-2">
            <div
              aria-hidden={store.mode !== "normal"}
              class="pointer-events-auto flex min-w-0 items-center gap-1"
              style={{
                "pointer-events": buttonsSpring() > 0.5 ? "auto" : "none",
              }}
            >
              <TooltipKeybind
                placement="top"
                title={language.t("prompt.action.attachFile")}
                keybind={command.keybind("file.attach")}
              >
                <IconButton
                  icon="plus"
                  data-action="prompt-attach"
                  type="button"
                  style={buttons()}
                  onClick={pick}
                  disabled={store.mode !== "normal" || !actionReady()}
                  tabIndex={store.mode === "normal" ? undefined : -1}
                  aria-label={language.t("prompt.action.attachFile")}
                />
              </TooltipKeybind>
              <Show when={store.mode === "normal"}>
                <PromptModelControl
                  triggerStyle={buttons}
                  actionReady={actionReady}
                  model={local.model}
                  language={language}
                  command={command}
                  onClose={restoreFocus}
                />
              </Show>
              <Show when={props.homeMode && store.mode === "normal"}>
                <WorkspaceChip style={buttons()} />
              </Show>
            </div>

            <div class="flex items-center gap-2 pointer-events-auto">
              <SessionContextUsage placement="top" />
              <Tooltip placement="top" inactive={(working() ? abortReady() : actionReady()) && !working() && blank()} value={tip()}>
                <SendButton
                  stopping={stopping()}
                  disabled={promptSendDisabled({
                    stopping: stopping(),
                    actionReady: actionReady(),
                    abortReady: abortReady(),
                    blank: blank(),
                  })}
                  aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
                />
              </Tooltip>
            </div>
          </div>
        </div>
      </DockSegmentForm>
    </div>
  )
}
