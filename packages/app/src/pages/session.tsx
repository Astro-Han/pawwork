import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createEffect, createSignal, on } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { useLocation, useSearchParams } from "@solidjs/router"
import { useComments } from "@/context/comments"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { buildDesktopContext } from "@/utils/desktop-context"
import { createSessionComposerState, HomeComposerRegion } from "@/pages/session/composer"
import { createSizing } from "@/pages/session/helpers"
import { createSessionExecutionState } from "@/pages/session/session-execution-directory"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionPageComposerRegion } from "@/pages/session/session-composer-region"
import { SessionMainView } from "@/pages/session/session-main-view"
import { createSessionRunning, isSessionRunning } from "@/pages/session/session-running-state"
import { createSessionTurnChanges } from "@/pages/session/session-turn-changes"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { createSessionCommentContext } from "@/pages/session/use-session-comment-context"
import { useSessionDesktopContext } from "@/pages/session/use-session-desktop-context"
import { createSessionFollowups } from "@/pages/session/use-session-followups"
import { useSessionKeyboardFocus } from "@/pages/session/use-session-keyboard-focus"
import { createSessionNewWorktree } from "@/pages/session/use-session-new-worktree"
import { useSessionRefreshEffects } from "@/pages/session/use-session-refresh-effects"
import { createSessionRevert } from "@/pages/session/use-session-revert"
import { createSessionReviewPanel } from "@/pages/session/use-session-review-panel"
import { createSessionReviewState } from "@/pages/session/use-session-review-state"
import { createSessionRouteTabs } from "@/pages/session/use-session-route-tabs"
import { createSessionRevertSupport } from "@/pages/session/use-session-revert-support"
import { createSessionTimelineData } from "@/pages/session/use-session-timeline-data"
import { createSessionTimelineInteraction } from "@/pages/session/use-session-timeline-interaction"
import { createSessionDeferredRender } from "@/pages/session/use-session-deferred-render"
import { createSessionPageDiagnostics } from "@/pages/session/use-session-page-diagnostics"
import { useSessionRoutePromptBootstrap } from "@/pages/session/use-session-route-prompt-bootstrap"
import { useSessionVcsRefresh } from "@/pages/session/use-session-vcs-refresh"
import { rendererAbortDiagnosticSource } from "@/session/abort-source"

export default function Page() {
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const settings = useSettings()
  const server = useServer()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string; skill?: string }>()
  const { params, tabs, view } = useSessionLayout()

  useSessionDesktopContext({
    context: () =>
      buildDesktopContext({
        directory: sdk.directory,
        sessionID: params.id ?? null,
        route: `${location.pathname}${location.search}${location.hash}`,
        locale: language.locale(),
      }),
    send: window.api?.setDesktopContext,
  })

  useSessionRoutePromptBootstrap({
    ready: prompt.ready,
    sessionID: () => params.id,
    prompt: () => searchParams.prompt,
    setPrompt: (text) => prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length),
    clearPrompt: () => setSearchParams({ ...searchParams, prompt: undefined }),
  })

  // "Use in chat" from the Skills gallery lands here with ?skill=<name>. Seed the
  // composer with the same structured skill chip the slash picker inserts, so
  // activation is deterministic (this exact skill loads, not a description match).
  useSessionRoutePromptBootstrap({
    ready: prompt.ready,
    sessionID: () => params.id,
    prompt: () => searchParams.skill,
    setPrompt: (name) =>
      prompt.set([{ type: "skill", name, source: "skill", content: `/${name}`, start: 0, end: name.length + 1 }], name.length + 1),
    clearPrompt: () => setSearchParams({ ...searchParams, skill: undefined }),
  })

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopSidePanelOpen = createMemo(() => isDesktop() && view().sidePanel.opened())
  const centered = createMemo(() => isDesktop())

  const timeline = createSessionTimelineData({
    serverKey: () => server.key,
    directory: () => params.dir ?? "",
    routeSessionID: () => params.id,
    sync,
    local,
  })
  const canReview = createMemo(() => !!sync.project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionRouteTabs({
    directory: () => params.dir ?? "",
    sessionID: () => params.id,
    layout,
    tabs,
    pathFromTab: file.pathFromTab,
    tabForPath: file.tab,
    review: reviewTab,
    hasReview: canReview,
  })
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const timelineSessionID = timeline.sessionID
  const timelineSessionKey = timeline.sessionKey
  const sessionActionReady = timeline.sessionActionReady
  const submitReady = timeline.actionReady
  const workspaceSubmitReady = timeline.workspaceSubmitReady
  const timelineIsChildSession = timeline.isChildSession
  const timelineMessages = timeline.messages
  const timelineMessagesReady = timeline.messagesReady
  const timelineDiffs = timeline.diffs
  const timelineUserMessages = timeline.userMessages
  const timelineRevertMessageID = timeline.revertMessageID
  const timelineVisibleUserMessages = timeline.visibleUserMessages
  const timelineHistoryMore = timeline.historyMore
  const timelineHistoryLoading = timeline.historyLoading
  const lastUserMessage = timeline.lastUserMessage
  const turnChangeController = createSessionTurnChanges({ sessionID: timelineSessionID, sessionMessages: timelineMessages })
  const diagnostics = createSessionPageDiagnostics({
    routeSessionID: () => params.id,
    timelineSessionID,
    routeMessagesReady: timeline.routeMessagesReady,
    visibleMessagesReady: timelineMessagesReady,
    actionReady: submitReady,
    messageCachePresent: timeline.messageCachePresent,
    sessionInfoPresent: timeline.sessionInfoPresent,
    statusKnown: timeline.statusKnown,
    historyMore: timelineHistoryMore,
    historyLoading: timelineHistoryLoading,
    messages: timelineMessages,
  })
  const emitAbortDiagnostic = diagnostics.emitAbortDiagnostic
  const haltAbort = (sessionID: string, source: "revert" | "autoHeal" = "autoHeal") =>
    isSessionRunning(sync.data.session_status[sessionID], sync.data.message[sessionID])
      ? sdk.client.session
          .abort({ sessionID, source: rendererAbortDiagnosticSource({ sessionID, source }) })
          .then((result) => {
            emitAbortDiagnostic(sessionID, source, result.data === false ? "ignored_awaiting_question" : "aborted")
            return result
          })
      : Promise.resolve()
  const haltWithSnapshot = (
    snapshot: ReturnType<typeof sync.retainDirectory> & { client: typeof sdk.client },
    sessionID: string,
  ) =>
    isSessionRunning(snapshot.store.session_status[sessionID], snapshot.store.message[sessionID])
      ? snapshot.client.session
          .abort({ sessionID, source: rendererAbortDiagnosticSource({ sessionID, source: "revert" }) })
          .then((result) => {
            emitAbortDiagnostic(sessionID, "revert", result.data === false ? "ignored_awaiting_question" : "aborted")
            return result
          })
      : Promise.resolve()
  const composer = createSessionComposerState({
    sessionID: timelineSessionID,
  })
  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  const [mobileTab, setMobileTab] = createSignal<"session" | "changes">("session")
  const deferRender = createSessionDeferredRender(timelineSessionKey)

  const turnDiffs = () => []
  const mobileChanges = createMemo(() => !isDesktop() && mobileTab() === "changes")
  const wantsReview = createMemo(() =>
    isDesktop() ? desktopSidePanelOpen() && view().sidePanel.tab() === "review" : mobileChanges(),
  )
  const executionState = createSessionExecutionState({
    serverKey: () => server.key,
    routeDirectory: () => sdk.directory,
    session: timeline.sessionInfo,
  })
  const currentExecutionScope = executionState.scope
  const reviewState = createSessionReviewState({
    directory: () => sdk.directory,
    executionScope: currentExecutionScope,
    sessionKey: timelineSessionKey,
    sessionID: timelineSessionID,
    latestTurnChange: () => {
      const id = lastUserMessage()?.id
      return id ? turnChangeController.turnChanges[id] : undefined
    },
    sync,
    sdk,
    wantsReview,
    turnDiffs,
    artifactDiffs: timelineDiffs,
  })

  const newSessionWorktree = createSessionNewWorktree({
    directory: () => sdk.directory,
    projectWorktree: () => sync.project?.worktree,
  })

  let inputRef!: HTMLDivElement

  useSessionRefreshEffects({
    directory: () => sdk.directory,
    routeSessionID: () => params.id,
    timelineSessionID,
    statusType: (id) => sync.data.session_status[id]?.type,
    blocked: composer.blocked,
    hasMessageCache: (id) => sync.data.message[id] !== undefined,
    hasTodoCache: (id) => globalSync.data.session_todo[id] !== undefined,
    isTodoInvalidated: globalSync.todoHydrate.isAuthoritativelyInvalidated,
    scheduleTodoHydrate: globalSync.todoHydrate.scheduleHydrate,
    cancelTodoHydrate: globalSync.todoHydrate.cancelHydrate,
    recoveryEpoch: globalSync.todoHydrate.recoveryEpoch,
    validatedRecoveryEpoch: globalSync.todoHydrate.validatedRecoveryEpoch,
    syncSession: (id, options) => sync.session.sync(id, options),
    syncTodo: (id, options) => sync.session.todo(id, options),
    emitRendererDiagnostic,
  })

  useSessionVcsRefresh({
    directory: executionState.directory,
    event: sdk.event,
    branch: () => sync.data.vcs?.branch,
    defaultBranch: () => sync.data.vcs?.default_branch,
    reset: reviewState.resetVcs,
    mode: reviewState.vcsMode,
    wantsReview,
    load: reviewState.loadVcs,
  })

  const commentContext = createSessionCommentContext({
    attachmentLabel: () => language.t("common.attachment"),
    getFileContent: (path) => file.get(path)?.content?.content,
    sourceFilesystemDirectory: () => sdk.directory,
    comments,
    promptContext: prompt.context,
  })

  const focusInput = () => {
    if (timelineIsChildSession()) return
    inputRef?.focus()
  }

  const reviewPanel = createSessionReviewPanel({
    activeFileTab,
    canReview,
    comments,
    commentContext,
    deferRender,
    file,
    isDesktop,
    language,
    reviewState,
    routeSessionID: () => params.id,
    sdk,
    sessionKey: timelineSessionKey,
    sync,
    view,
    wantsReview,
    openTab: tabs().open,
    setActiveTab: tabs().setActive,
  })

  const timelineInteraction = createSessionTimelineInteraction({
    routeSessionID: () => params.id,
    sessionKey: timelineSessionKey,
    sessionID: timelineSessionID,
    messagesReady: timelineMessagesReady,
    loadedMessages: () => timelineMessages().length,
    visibleUserMessages: timelineVisibleUserMessages,
    historyMore: timelineHistoryMore,
    historyLoading: timelineHistoryLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    consumePendingMessage: layout.pendingMessage.consume,
  })
  const activeMessage = timelineInteraction.activeMessage
  const autoScroll = timelineInteraction.autoScroll
  const historyWindow = timelineInteraction.historyWindow
  const resumeScroll = timelineInteraction.resumeScroll
  const scheduleScrollState = timelineInteraction.scheduleScrollState
  const scrollDock = timelineInteraction.scrollDock
  const submitLatest = timelineInteraction.submitLatest
  const setScrollRef = timelineInteraction.setScrollRef

  useSessionKeyboardFocus({
    blocked: composer.blocked,
    dialogActive: () => !!dialog.active,
    inputRef: () => inputRef,
    isChildSession: timelineIsChildSession,
    markScrollGesture: timelineInteraction.markScrollGesture,
    terminalActive: terminal.active,
    terminalOpened: () => view().terminal.opened(),
  })

  useSessionCommands({
    navigateMessageByOffset: timelineInteraction.navigateMessageByOffset,
    setActiveMessage: activeMessage.setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const revertSupport = createSessionRevertSupport({
    directory: () => sdk.directory,
    routeDir: () => params.dir,
    sessionID: timelineSessionID,
    attachmentLabel: () => language.t("common.attachment"),
    t: language.t,
    prompt,
    sync,
    createClient: sdk.createClient,
    currentExecutionScope,
  })
  const fail = revertSupport.fail

  const timelineRunning = createSessionRunning(
    () => {
      const id = timelineSessionID()
      return id ? sync.data.session_status[id] : undefined
    },
    () => {
      const id = timelineSessionID()
      return id ? sync.data.message[id] : undefined
    },
  )
  const busy = () => !sessionActionReady() || timelineRunning()

  const followups = createSessionFollowups({
    directory: () => sdk.directory,
    client: () => sdk.client,
    sessionID: timelineSessionID,
    sessionScope: timeline.sessionScope,
    actionReady: submitReady,
    isChildSession: timelineIsChildSession,
    busy,
    blocked: composer.blocked,
    settings,
    sync,
    globalSync,
    fail,
    resumeScroll,
    attachmentLabel: () => language.t("common.attachment"),
  })

  const sessionRevert = createSessionRevert({
    sessionID: timelineSessionID,
    revertMessageID: timelineRevertMessageID,
    timelineUserMessages,
    lineText: revertSupport.line,
    prompt,
    sync,
    snapshot: revertSupport.snapshot,
    actionReady: sessionActionReady,
    halt: haltWithSnapshot,
    draft: revertSupport.draftFrom,
    fail,
    merge: revertSupport.merge,
    roll: revertSupport.roll,
  })

  const actions = { revert: sessionRevert.revert }

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  const renderComposerRegion = (ctx?: { onModeChange: (mode: "normal" | "shell") => void }) => (
    <SessionPageComposerRegion
      state={composer}
      ready={!deferRender() && sessionActionReady()}
      actionReady={submitReady()}
      abortReady={sessionActionReady()}
      displaySessionID={timelineSessionID()}
      displaySessionKey={timelineSessionID() ? timelineSessionKey() : undefined}
      centered={centered()}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree.selected()}
      onNewSessionWorktreeReset={newSessionWorktree.reset}
      onSubmit={() => {
        comments.clear()
        submitLatest()
      }}
      onResponseSubmit={submitLatest}
      onModeChange={ctx?.onModeChange}
      followup={
        timelineSessionID() && submitReady() && !timelineIsChildSession()
          ? {
              queue: followups.queueEnabled,
              items: followups.followupDock(),
              sending: followups.sendingFollowup(),
              edit: followups.editingFollowup(),
              onQueue: followups.queueFollowup,
              onAbort: () => {
                followups.pause()
              },
              onSend: (id) => {
                void followups.sendFollowup(id, { manual: true })
              },
              onEdit: followups.editFollowup,
              onEditLoaded: followups.clearFollowupEdit,
            }
          : undefined
      }
      revert={
        sessionRevert.rolled().length > 0
          ? {
              items: sessionRevert.rolled(),
              restoring: sessionRevert.restoring(),
              disabled: sessionRevert.reverting() || !sessionActionReady(),
              onRestore: sessionRevert.restore,
            }
          : undefined
      }
      setPromptDockRef={scrollDock.setPromptDockRef}
    />
  )

  const renderHomeComposerRegion = (ctx?: { onModeChange: (mode: "normal" | "shell") => void }) => (
    <HomeComposerRegion
      inputRef={(el) => {
        inputRef = el
      }}
      actionReady={workspaceSubmitReady()}
      newSessionWorktree={newSessionWorktree.selected()}
      onNewSessionWorktreeReset={newSessionWorktree.reset}
      onSubmit={() => {
        comments.clear()
        submitLatest()
      }}
      onModeChange={ctx?.onModeChange}
      setPromptDockRef={scrollDock.setPromptDockRef}
    />
  )

  return (
    <SessionMainView
      activeSessionID={params.id}
      isDesktop={isDesktop()}
      mobileTab={mobileTab()}
      setMobileTab={setMobileTab}
      language={language}
      routeSessionID={params.id}
      routeReady={timelineMessagesReady()}
      transitioning={timeline.transitioning()}
      timelineSessionID={timelineSessionID()}
      timelineSessionKey={timelineSessionKey()}
      timelineMessagesReady={timelineMessagesReady()}
      timelineMessages={timelineMessages()}
      turnChangeController={turnChangeController}
      mobileChanges={mobileChanges()}
      mobileFallback={reviewPanel.mobileFallback()}
      actions={actions}
      scroll={scrollDock.scroll}
      resumeScroll={resumeScroll}
      setScrollRef={setScrollRef}
      scheduleScrollState={scheduleScrollState}
      autoScroll={autoScroll}
      markScrollGesture={timelineInteraction.markScrollGesture}
      hasScrollGesture={activeMessage.hasScrollGesture}
      markUserScroll={activeMessage.markUserScroll}
      onTimelineScrollIntent={timelineInteraction.onTimelineScrollIntent}
      onTimelineScrollObservation={timelineInteraction.onTimelineScrollObservation}
      historyWindow={historyWindow}
      centered={centered()}
      setContentRef={scrollDock.setContentRef}
      historyMore={timelineHistoryMore()}
      historyLoading={timelineHistoryLoading()}
      anchor={timelineInteraction.anchor}
      virtualizerBridge={timelineInteraction.virtualizerBridge}
      layoutTransactionActive={timelineInteraction.layoutTransactionActive}
      layoutTransactionID={timelineInteraction.layoutTransactionID}
      layoutTransactionKind={timelineInteraction.layoutTransactionKind}
      composerSession={renderComposerRegion()}
      composerHome={renderHomeComposerRegion}
      canReview={canReview}
      reviewDiffs={reviewPanel.diffs}
      hasReview={reviewPanel.hasReview}
      reviewCount={reviewPanel.reviewCount}
      reviewPanel={reviewPanel.reviewPanel}
      files={reviewPanel.files}
      size={size}
    />
  )
}
