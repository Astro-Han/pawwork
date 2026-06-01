import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { Binary } from "@opencode-ai/util/binary"
import { batch, type Accessor } from "solid-js"
import type { FileSelection } from "@/context/file"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { emitRendererDiagnostic, sessionAbortDiagnosticEvent } from "@/context/renderer-diagnostics"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { promptProbe } from "@/testing/prompt"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { rendererAbortDiagnosticSource, type RendererAbortSource } from "@/session/abort-source"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { reportInvariantBreach } from "./invariant"
import { formatServerError } from "@/utils/server-errors"
import { canSubmitPrompt } from "@/pages/session/session-action-readiness"
import { type PromptRouteScope, promptScopeForSession } from "@/pages/session/prompt-route-scope"
import { type PortableDraftOwner, usePortableDraft } from "./portable-draft"
import { type PinnedDraftOwner, usePinnedDraft } from "./pinned-draft"
import type { ResolvedMention } from "./mention-metadata"
import { followupCommandText, type FollowupDraft } from "./followup-draft"

/**
 * Submit ownership identifies which draft owner a given submit attempt operates on.
 * Captured once at the top of handleSubmit and frozen for the lifetime of that submit.
 * Used by clearInput/restoreInput so a successful clear or failure restore only
 * touches the owner whose revision matches the captured value at submit time.
 */
export type SubmitOwnership =
  | { kind: "portable"; revision: number; sourceFilesystemDirectory: string }
  | { kind: "pinned"; revision: number; directory: string }
  | { kind: "route"; scope: PromptRouteScope }

/**
 * Decide which owner owns this submit. Pinned beats portable when both match the
 * current homepage directory. When on a concrete session route (id present),
 * ownership is always the route-scoped prompt store.
 */
export function detectSubmitOwnership(params: {
  isHomepage: boolean
  pinned: PinnedDraftOwner
  portable: PortableDraftOwner
  sourceFilesystemDirectory: string
  routeScope: PromptRouteScope
}): SubmitOwnership {
  if (params.isHomepage) {
    const pinnedSlot = params.pinned.current()
    if (pinnedSlot && pinnedSlot.directory === params.sourceFilesystemDirectory) {
      return { kind: "pinned", revision: pinnedSlot.revision, directory: pinnedSlot.directory }
    }
    const portableSnapshot = params.portable.snapshot()
    if (portableSnapshot && portableSnapshot.sourceFilesystemDirectory === params.sourceFilesystemDirectory) {
      return {
        kind: "portable",
        revision: portableSnapshot.revision,
        sourceFilesystemDirectory: portableSnapshot.sourceFilesystemDirectory,
      }
    }
  }
  return { kind: "route", scope: params.routeScope }
}

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

const pending = new Map<string, PendingPrompt>()
type AbortSource = Extract<RendererAbortSource, "ctrlG" | "emptyEnter" | "escape" | "stopButton">

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = followupCommandText(input.draft)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  // Path D: first prompt part is a marked TextPart (command metadata present).
  // flatText projects all content parts into a single string for argument slicing.
  // If the content prefix invariant is violated, report and fall through to legacy.
  const first = input.draft.prompt[0]
  if (first?.type === "text" && first.command) {
    const markedName = first.command.name
    const prefix = `/${markedName} `
    const flatText = input.draft.prompt
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
    if (!flatText.startsWith(prefix)) {
      reportInvariantBreach("sendFollowupDraft: command content prefix mismatch", first)
      // Fall through to the legacy command check below.
    } else {
      setBusy()
      try {
        if (!(await wait())) {
          setIdle()
          return false
        }
        await input.client.session.command({
          sessionID: input.draft.sessionID,
          command: markedName,
          arguments: flatText.slice(prefix.length),
          agent: input.draft.agent,
          model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
          locale: input.draft.locale,
          variant: input.draft.variant,
          parts: images.map((attachment) => ({
            id: Identifier.ascending("part"),
            type: "file" as const,
            mime: attachment.mime,
            url: attachment.dataUrl,
            filename: attachment.filename,
          })),
        })
        return true
      } catch (err) {
        setIdle()
        throw err
      }
    }
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        locale: input.draft.locale,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      locale: input.draft.locale,
      messageID,
      parts: requestParts,
      variant: input.draft.variant,
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  sessionID?: Accessor<string | undefined>
  isNewSession?: Accessor<boolean>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  autoAccept: Accessor<boolean>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  actionReady?: Accessor<boolean>
  abortReady?: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  navigate?: (path: string) => void
  routeParams?: Accessor<{ dir?: string; id?: string }>
}

type CommentItem = {
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
  resolvedMentions?: ResolvedMention[]
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = input.navigate ?? (() => undefined)
  const sdk = useSDK()
  const sync = useSync()
  const globalSync = useGlobalSync()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const layout = useLayout()
  const language = useLanguage()
  const params: Accessor<{ dir?: string; id?: string }> = input.routeParams ?? (() => ({}))
  const portable = usePortableDraft()
  const pinned = usePinnedDraft()
  const sessionID = input.sessionID ?? (() => params().id)
  const isNewSession = input.isNewSession ?? (() => !sessionID())
  const actionReady = input.actionReady ?? (() => true)
  const abortReady = input.abortReady ?? actionReady

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const emitAbortDiagnostic = (input: {
    routeSessionID?: string
    visibleSessionID?: string
    timelineSessionID?: string
    source: AbortSource
    result: "aborted" | "ignored_awaiting_question"
  }) => {
    void emitRendererDiagnostic(sessionAbortDiagnosticEvent(input)).catch(() => undefined)
  }

  const abort = async (source: AbortSource = "stopButton") => {
    if (!abortReady()) return Promise.resolve()

    const activeSessionID = sessionID()
    if (!activeSessionID) return Promise.resolve()

    input.onAbort?.()

    const queued = pending.get(activeSessionID)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(activeSessionID)
      emitAbortDiagnostic({
        routeSessionID: activeSessionID,
        visibleSessionID: activeSessionID,
        timelineSessionID: activeSessionID,
        source,
        result: "aborted",
      })
      return Promise.resolve()
    }
    return sdk.client.session
      .abort({
        sessionID: activeSessionID,
        source: rendererAbortDiagnosticSource({ sessionID: activeSessionID, source }),
      })
      .then((result) => {
        emitAbortDiagnostic({
          routeSessionID: activeSessionID,
          visibleSessionID: activeSessionID,
          timelineSessionID: activeSessionID,
          source,
          result: result.data === false ? "ignored_awaiting_question" : "aborted",
        })
      })
      .catch(() => {})
  }

  const restoreCommentItems = (items: CommentItem[]) => {
    for (const item of items) {
      prompt.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
        resolvedMentions: item.resolvedMentions,
      })
    }
  }

  const removeCommentItems = (items: { key: string }[]) => {
    for (const item of items) {
      prompt.context.remove(item.key)
    }
  }

  const clearContext = () => {
    for (const item of prompt.context.items()) {
      prompt.context.remove(item.key)
    }
  }

  const seed = (dir: string, info: Session) => {
    const [, setStore] = globalSync.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const handleSubmit = async (event: Event) => {
    event.preventDefault()

    const currentPrompt = prompt.current()
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const creatingNewSession = isNewSession()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) abort(event instanceof KeyboardEvent ? "emptyEnter" : "stopButton")
      return
    }
    if (
      !canSubmitPrompt({
        mode,
        text,
        submitReady: actionReady(),
        commandsReady: sync.data.command_ready,
      })
    ) {
      return
    }

    const currentModel = local.model.current()
    const currentAgent = local.agent.current()
    const variant = local.model.variant.current()
    if (!currentModel || (!currentAgent && !creatingNewSession)) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()
    promptProbe.start()

    // Capture context items and the "isHomepage" route bit BEFORE any await.
    // navigate() lands the new session route mid-await and switches params.id
    // from undefined to the created id; reading these after navigate() would
    // observe an EMPTY new-session store and a "session route" verdict, which
    // breaks ownership detection (Bug 1) and the comment-restore path.
    const submittedContext = prompt.context.items().slice()
    const routeParams = params()
    const submittedIsHomepage = !routeParams.id

    const projectDirectory = sdk.directory
    // Capture the source scope before any await so navigate() cannot change params.id under us
    const sourcePromptScope: PromptRouteScope = {
      dir: routeParams.dir ?? base64Encode(projectDirectory),
      id: routeParams.id,
    }

    // Capture submit ownership BEFORE any await. Reading pinned.current() and
    // portable.snapshot() here freezes the revision at submit time; if the user
    // types into the editor during the await, the owner's live revision bumps
    // past this value and confirmOwnerCleared will refuse to wipe under that
    // mismatch — preserving the post-submit typing.
    const ownership: SubmitOwnership = detectSubmitOwnership({
      isHomepage: submittedIsHomepage,
      pinned,
      portable,
      sourceFilesystemDirectory: projectDirectory,
      routeScope: sourcePromptScope,
    })

    const shouldAutoAccept = creatingNewSession && input.autoAccept()
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sdk.client

    if (creatingNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({ directory: projectDirectory })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        WorktreeState.pending(createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sdk.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        globalSync.child(sessionDirectory)
      }

      input.onNewSessionWorktreeReset?.()
    }

    let session = input.info()
    if (!session && creatingNewSession) {
      const created = await client.session
        .create()
        .then((x) => x.data ?? undefined)
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sessionDirectory, created)
        session = created
        if (shouldAutoAccept) permission.enableAutoAccept(session.id, sessionDirectory)
        local.session.promote(sessionDirectory, session.id)
        layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
        navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel.id,
      providerID: currentModel.provider.id,
    }
    const locale = language.intl()
    const agent = creatingNewSession ? "build" : currentAgent!.name
    // Use the pre-await capture; reading prompt.context.items() here would land
    // in the freshly-created session's empty context store after navigate().
    const context = submittedContext
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      locale,
      variant,
    }

    const promptScope = promptScopeForSession({
      routeDir: params().dir,
      routeDirectory: projectDirectory,
      targetDirectory: sessionDirectory,
      sessionID: session.id,
    })

    const submittedDraft = {
      prompt: currentPrompt,
      context,
    }

    // Submitted owner-backed drafts leave the live draft owner before the async
    // send settles. The owner only represents editable unsent draft state;
    // failure recovery uses submittedDraft captured above.
    const clearInput = (owned: SubmitOwnership) => {
      switch (owned.kind) {
        case "pinned":
          prompt.reset(sourcePromptScope)
          pinned.clearAll(owned.revision)
          break
        case "portable":
          prompt.reset(sourcePromptScope)
          portable.clear(owned.revision)
          break
        case "route":
          prompt.reset(owned.scope)
          break
      }
      input.setMode("normal")
      input.setPopover(null)
    }

    const confirmOwnerCleared = (owned: SubmitOwnership) => {
      switch (owned.kind) {
        case "portable":
          portable.clear(owned.revision)
          break
        case "pinned":
          pinned.clearAll(owned.revision)
          break
        case "route":
          // route store was reset synchronously by clearInput; no owner snapshot.
          break
      }
    }

    const isActivePromptScope = (scope: PromptRouteScope) => {
      const active = params()
      return active.dir === scope.dir && active.id === scope.id
    }

    const shouldRestoreOwnerDraft = (ownerHasNewDraft: boolean) => {
      if (ownerHasNewDraft) return false
      if (!isActivePromptScope(promptScope)) return true
      return !prompt.dirty() && prompt.context.items().length === 0
    }

    const restoreInput = (owned: SubmitOwnership) => {
      switch (owned.kind) {
        case "portable":
          if (!shouldRestoreOwnerDraft(portable.snapshot() !== null)) return
          prompt.set(submittedDraft.prompt, input.promptLength(submittedDraft.prompt), promptScope)
          prompt.context.replaceAll(submittedDraft.context.map(({ key: _omit, ...rest }) => rest), promptScope)
          break
        case "pinned":
          if (!shouldRestoreOwnerDraft(pinned.current() !== null)) return
          prompt.set(submittedDraft.prompt, input.promptLength(submittedDraft.prompt), promptScope)
          prompt.context.replaceAll(submittedDraft.context.map(({ key: _omit, ...rest }) => rest), promptScope)
          break
        case "route": {
          prompt.set(currentPrompt, input.promptLength(currentPrompt), promptScope)
          restoreCommentItems(commentItems)
          break
        }
      }
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        const cursorPrompt = owned.kind === "route" ? currentPrompt : prompt.current()
        setCursorPosition(editor, input.promptLength(cursorPrompt))
        input.queueScroll()
      })
    }

    // commentItems is referenced by restoreInput (route case) and by the prompt
    // path below. Compute it before the queue branch so both can use it.
    // Note: it is only meaningful for the prompt-submit path (where comment
    // context items exist); the queue branch ignores it.
    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

    if (!creatingNewSession && mode === "normal" && input.shouldQueue?.()) {
      // Queue path is unreachable for portable/pinned homepage submits because
      // shouldQueue only fires when !creatingNewSession — homepage submits always
      // create a new session. SubmitOwnership.kind is always "route" here.
      input.onQueue?.(draft)
      clearContext()
      clearInput(ownership)
      // Queue path is synchronous; tear down owner snapshot immediately.
      // ownership.kind is "route" here (see comment above), so this is a no-op
      // for the only kind reachable, but the call is kept for parity.
      confirmOwnerCleared(ownership)
      return
    }

    promptProbe.submit({ sessionID: session.id, directory: sessionDirectory })
    input.onSubmit?.()

    if (mode === "shell") {
      clearInput(ownership)
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .then(() => {
          confirmOwnerCleared(ownership)
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput(ownership)
        })
      return
    }

    // Path D: first prompt part is a marked TextPart (command metadata present).
    // flatText projects all content parts into a single string for argument slicing.
    // If the content prefix invariant is violated, report and fall through to legacy.
    const firstPart = currentPrompt[0]
    if (firstPart?.type === "text" && firstPart.command) {
      const markedName = firstPart.command.name
      const markedPrefix = `/${markedName} `
      const flatText = currentPrompt
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      if (!flatText.startsWith(markedPrefix)) {
        reportInvariantBreach("handleSubmit: command content prefix mismatch", firstPart)
        // Fall through to the legacy slash-command check below.
      } else {
        clearInput(ownership)
        client.session
          .command({
            sessionID: session.id,
            command: markedName,
            arguments: flatText.slice(markedPrefix.length),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            locale,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .then(() => {
            confirmOwnerCleared(ownership)
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput(ownership)
          })
        return
      }
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput(ownership)
        client.session
          .command({
            sessionID: session.id,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: `${model.providerID}/${model.modelID}`,
            locale,
            variant,
            parts: images.map((attachment) => ({
              id: Identifier.ascending("part"),
              type: "file" as const,
              mime: attachment.mime,
              url: attachment.dataUrl,
              filename: attachment.filename,
            })),
          })
          .then(() => {
            confirmOwnerCleared(ownership)
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput(ownership)
          })
        return
      }
    }

    const messageID = Identifier.ascending("message")
    const submittedPromptLength = input.promptLength(currentPrompt)
    const submittedImageCount = images.length
    const submittedCommentCount = input.commentCount()

    const removeOptimisticMessage = () => {
      sync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    removeCommentItems(commentItems)
    clearInput(ownership)
    void emitRendererDiagnostic({
      name: "session.action.submit",
      trace_id: messageID,
      route_session_id: session.id,
      visible_session_id: session.id,
      timeline_session_id: session.id,
      data: {
        action: "submit",
        provider: model.providerID,
        model: model.modelID,
        endpoint_kind: "prompt",
        prompt_length: submittedPromptLength,
        image_count: submittedImageCount,
        comment_count: submittedCommentCount,
      },
    }).catch(() => {})

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        // restoreInput handles route-case comment items internally; owner-backed
        // cases re-push context from the snapshot via replaceAll.
        restoreInput(ownership)
      }

      pending.set(session.id, { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(session.id)
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      client,
      sync,
      globalSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).then((ok) => {
      // Only tear down the owner snapshot if the send actually went through.
      // sendFollowupDraft returns false when `before` (worktree wait) bailed; in
      // that case the cleanup path already restored the input via the pending
      // controller's cleanup() handler.
      if (ok) confirmOwnerCleared(ownership)
    }).catch((err) => {
      pending.delete(session.id)
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      // restoreInput handles route-case comment items internally; owner-backed
      // cases re-push context from the snapshot via replaceAll.
      restoreInput(ownership)
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
