import type { Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { base64Encode } from "@opencode-ai/util/encode"
import { Binary } from "@opencode-ai/util/binary"
import type { Accessor } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { type ImageAttachmentPart, type Prompt, usePrompt } from "@/context/prompt"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { promptProbe } from "@/testing/prompt"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { reportInvariantBreach } from "./invariant"
import { formatServerError } from "@/utils/server-errors"
import { canSubmitPrompt } from "@/pages/session/session-action-readiness"
import { type PromptRouteScope, promptScopeForSession } from "@/pages/session/prompt-route-scope"
import { usePortableDraft } from "./portable-draft"
import { usePinnedDraft } from "./pinned-draft"
import type { FollowupDraft } from "./followup-draft"
import { detectSubmitOwnership, type SubmitOwnership } from "./submit-ownership"
import { sendFollowupDraft } from "./send-followup-draft"
import { createAbort, pending } from "./submit-abort"
import { createPromptDraftLifecycle } from "./prompt-draft-lifecycle"
import { createWaitForWorktree } from "./wait-for-worktree"

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

  const abort = createAbort({
    abortReady,
    sessionID,
    onAbort: input.onAbort,
    client: () => sdk.client,
  })

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
    // A prompt carrying an inline skill chip flows through promptAsync. Its
    // flattened text can start with "/name" (chip at offset 0), which would
    // otherwise be misrouted to the legacy session.command endpoint below.
    const hasSkillPart = currentPrompt.some((part) => part.type === "skill")

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
        hasSkillPart,
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

    // commentItems is referenced by restoreInput (route case) and by the prompt
    // path below. Compute it before the queue branch so both can use it.
    // Note: it is only meaningful for the prompt-submit path (where comment
    // context items exist); the queue branch ignores it.
    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())

    // Owner-backed drafts leave the live draft owner before the async send
    // settles; the owner only represents editable unsent draft state, and
    // failure recovery restores from submittedDraft captured above. The
    // lifecycle binds this submit's ownership snapshot, so its methods are
    // no-arg and can be handed to waitForWorktree as a bound restore callback.
    const lifecycle = createPromptDraftLifecycle({
      prompt,
      pinned,
      portable,
      params,
      ownership,
      sourcePromptScope,
      promptScope,
      mode,
      currentPrompt,
      submittedDraft,
      commentItems,
      editor: input.editor,
      promptLength: input.promptLength,
      queueScroll: input.queueScroll,
      setMode: input.setMode,
      setPopover: input.setPopover,
    })

    if (!creatingNewSession && mode === "normal" && input.shouldQueue?.()) {
      // Queue path is unreachable for portable/pinned homepage submits because
      // shouldQueue only fires when !creatingNewSession — homepage submits always
      // create a new session. SubmitOwnership.kind is always "route" here.
      input.onQueue?.(draft)
      lifecycle.clearContext()
      lifecycle.clearInput()
      // Queue path is synchronous; tear down owner snapshot immediately.
      // ownership.kind is "route" here (see comment above), so this is a no-op
      // for the only kind reachable, but the call is kept for parity.
      lifecycle.confirmOwnerCleared()
      return
    }

    promptProbe.submit({ sessionID: session.id, directory: sessionDirectory })
    input.onSubmit?.()

    if (mode === "shell") {
      lifecycle.clearInput()
      client.session
        .shell({
          sessionID: session.id,
          agent,
          model,
          command: text,
        })
        .then(() => {
          lifecycle.confirmOwnerCleared()
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          lifecycle.restoreInput()
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
        lifecycle.clearInput()
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
            lifecycle.confirmOwnerCleared()
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            lifecycle.restoreInput()
          })
        return
      }
    }

    if (text.startsWith("/") && !hasSkillPart) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        lifecycle.clearInput()
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
            lifecycle.confirmOwnerCleared()
          })
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            lifecycle.restoreInput()
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

    lifecycle.removeSubmittedCommentItems()
    lifecycle.clearInput()
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

    const waitForWorktree = createWaitForWorktree({
      sessionDirectory,
      projectDirectory,
      sessionID: session.id,
      sync,
      language,
      removeOptimisticMessage,
      restoreInput: lifecycle.restoreInput,
    })

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
      if (ok) lifecycle.confirmOwnerCleared()
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
      lifecycle.restoreInput()
    })
  }

  return {
    abort,
    handleSubmit,
  }
}
