import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createMemo, createEffect, createComputed, createSignal, on, onCleanup, untrack } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocation, useSearchParams } from "@solidjs/router"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"
import { useComments } from "@/context/comments"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import {
  createSessionPerformanceDiagnostics,
  emitRendererDiagnostic,
  sessionAbortDiagnosticEvent,
} from "@/context/renderer-diagnostics"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useServer } from "@/context/server"
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { buildDesktopContext } from "@/utils/desktop-context"
import { createSessionComposerState } from "@/pages/session/composer"
import { createExecutionScopeTracker, type ExecutionScope } from "@/pages/session/execution-scope"
import { createSizing } from "@/pages/session/helpers"
import { promptScopeForSession } from "@/pages/session/prompt-route-scope"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionPageComposerRegion } from "@/pages/session/session-composer-region"
import { SessionMainView } from "@/pages/session/session-main-view"
import { createSessionRunning, isSessionRunning } from "@/pages/session/session-running-state"
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
import { createSessionTimelineData } from "@/pages/session/use-session-timeline-data"
import { createSessionTimelineInteraction } from "@/pages/session/use-session-timeline-interaction"
import { useSessionVcsRefresh } from "@/pages/session/use-session-vcs-refresh"
import { diffs as list } from "@/utils/diffs"
import { decode64 } from "@/utils/base64"
import { extractPromptFromParts } from "@/utils/prompt"
import { formatServerError } from "@/utils/server-errors"

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
  const shellSurface = useShellSurface()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
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

  createEffect(
    on(
      () => [prompt.ready(), params.id, searchParams.prompt] as const,
      ([ready, sessionID, text]) => {
        if (!ready || sessionID || !text) return
        untrack(() => {
          prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
          setSearchParams({ ...searchParams, prompt: undefined })
        })
      },
    ),
  )

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
  const emitAbortDiagnostic = (
    sessionID: string,
    source: "revert" | "autoHeal",
    result: "aborted" | "ignored_awaiting_question",
  ) => {
    emitDiagnostics(
      sessionAbortDiagnosticEvent({
        routeSessionID: params.id,
        visibleSessionID: timelineSessionID(),
        timelineSessionID: timelineSessionID(),
        source,
        mode: "hard",
        result,
      }),
    )
  }
  const haltAbort = (sessionID: string, source: "revert" | "autoHeal" = "autoHeal") =>
    isSessionRunning(sync.data.session_status[sessionID], sync.data.message[sessionID])
      ? sdk.client.session.abort({ sessionID, mode: "hard" }).then((result) => {
          emitAbortDiagnostic(sessionID, source, result.data === false ? "ignored_awaiting_question" : "aborted")
          return result
        })
      : Promise.resolve()
  const haltWithSnapshot = (
    snapshot: ReturnType<typeof sync.retainDirectory> & { client: typeof sdk.client },
    sessionID: string,
  ) =>
    isSessionRunning(snapshot.store.session_status[sessionID], snapshot.store.message[sessionID])
      ? snapshot.client.session.abort({ sessionID, mode: "hard" }).then((result) => {
          emitAbortDiagnostic(sessionID, "revert", result.data === false ? "ignored_awaiting_question" : "aborted")
          return result
        })
      : Promise.resolve()
  // sessionRevert chains halt with .then(), so its existing outer .catch
  // already handles abort failures. The auto-heal clock wants to see the
  // error so it can structured-warn — pass haltAbort directly there.
  const halt = (sessionID: string) => haltAbort(sessionID, "autoHeal").catch(() => {})
  const composer = createSessionComposerState({
    sessionID: timelineSessionID,
    fallbackSessionID: () => params.id,
    halt: haltAbort,
  })
  const timelineMessages = timeline.messages
  const timelineMessagesReady = timeline.messagesReady
  const timelineDiffs = timeline.diffs
  const timelineUserMessages = timeline.userMessages
  const timelineRevertMessageID = timeline.revertMessageID
  const timelineVisibleUserMessages = timeline.visibleUserMessages
  const timelineHistoryMore = timeline.historyMore
  const timelineHistoryLoading = timeline.historyLoading
  const lastUserMessage = timeline.lastUserMessage
  const countMessageParts = (message: unknown) => {
    if (!message || typeof message !== "object" || !("parts" in message)) return 0
    const parts = (message as { parts?: unknown }).parts
    return Array.isArray(parts) ? parts.length : 0
  }
  const timelineMessageMetrics = createMemo(() => {
    const messages = timelineMessages()
    return {
      messageCount: messages.length,
      partCount: messages.reduce((count, message) => count + countMessageParts(message), 0),
    }
  })
  const emitDiagnostics = (event: Parameters<typeof emitRendererDiagnostic>[0]) => {
    void emitRendererDiagnostic(event).catch(() => undefined)
  }

  createEffect(
    on(
      () => {
        const routeSessionID = params.id
        const visibleSessionID = timelineSessionID()
        const metrics = timelineMessageMetrics()
        return {
          routeSessionID,
          visibleSessionID,
          routeReady: timeline.routeMessagesReady(),
          visibleReady: timelineMessagesReady(),
          actionReady: submitReady(),
          messageCachePresent: timeline.messageCachePresent(),
          sessionInfoPresent: timeline.sessionInfoPresent(),
          statusKnown: timeline.statusKnown(),
          transitioning: !!routeSessionID && !!visibleSessionID && routeSessionID !== visibleSessionID,
          messageCount: metrics.messageCount,
          partCount: metrics.partCount,
          historyMore: timelineHistoryMore(),
          historyLoading: timelineHistoryLoading(),
        }
      },
      (state) => {
        emitDiagnostics({
          name: "session.view.state",
          route_session_id: state.routeSessionID,
          visible_session_id: state.visibleSessionID,
          timeline_session_id: state.visibleSessionID,
          data: {
            route_session_id: state.routeSessionID,
            visible_session_id: state.visibleSessionID,
            timeline_session_id: state.visibleSessionID,
            route_ready: state.routeReady,
            visible_ready: state.visibleReady,
            action_ready: state.actionReady,
            message_cache_present: state.messageCachePresent,
            session_info_present: state.sessionInfoPresent,
            status_known: state.statusKnown,
            transitioning: state.transitioning,
            message_count: state.messageCount,
            part_count: state.partCount,
            history_more: state.historyMore,
            history_loading: state.historyLoading,
          },
        })
      },
    ),
  )

  createEffect(
    on(
      () => {
        const id = timelineSessionID()
        return { routeSessionID: params.id, visibleSessionID: id, timelineSessionID: id }
      },
      (next, previous) => {
        if (!previous) return
        if (
          next.routeSessionID === previous.routeSessionID &&
          next.visibleSessionID === previous.visibleSessionID &&
          next.timelineSessionID === previous.timelineSessionID
        ) {
          return
        }
        emitDiagnostics({
          name: "session.identity.transition",
          route_session_id: next.routeSessionID,
          visible_session_id: next.visibleSessionID,
          timeline_session_id: next.timelineSessionID,
          data: {
            from_route_session_id: previous.routeSessionID,
            to_route_session_id: next.routeSessionID,
            from_visible_session_id: previous.visibleSessionID,
            to_visible_session_id: next.visibleSessionID,
            from_timeline_session_id: previous.timelineSessionID,
            to_timeline_session_id: next.timelineSessionID,
          },
        })
      },
      { defer: true },
    ),
  )

  createSessionPerformanceDiagnostics({
    routeSessionID: () => params.id,
    visibleSessionID: timelineSessionID,
    timelineSessionID,
  })

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  const [mobileTab, setMobileTab] = createSignal<"session" | "changes">("session")
  const [deferRender, setDeferRender] = createSignal(false)
  let deferRenderFrame: number | undefined
  let deferRenderTimer: number | undefined
  let deferRenderEpoch = 0

  const clearDeferRenderSchedule = () => {
    if (deferRenderFrame !== undefined) cancelAnimationFrame(deferRenderFrame)
    if (deferRenderTimer !== undefined) window.clearTimeout(deferRenderTimer)
    deferRenderFrame = undefined
    deferRenderTimer = undefined
  }

  onCleanup(clearDeferRenderSchedule)

  createComputed((prev) => {
    const key = timelineSessionKey()
    if (key !== prev) {
      const epoch = ++deferRenderEpoch
      setDeferRender(true)
      clearDeferRenderSchedule()
      deferRenderFrame = requestAnimationFrame(() => {
        deferRenderFrame = undefined
        deferRenderTimer = window.setTimeout(() => {
          deferRenderTimer = undefined
          if (epoch === deferRenderEpoch) setDeferRender(false)
        }, 0)
      })
    }
    return key
  }, timelineSessionKey())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const mobileChanges = createMemo(() => !isDesktop() && mobileTab() === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopSidePanelOpen() && view().sidePanel.tab() === "review" && activeTab() === "review"
      : mobileChanges(),
  )
  const executionScopeTracker = createExecutionScopeTracker()
  const currentExecutionScope = (): ExecutionScope =>
    executionScopeTracker({
      serverKey: server.key,
      directory: sdk.directory,
    })
  const reviewState = createSessionReviewState({
    directory: () => sdk.directory,
    executionScope: currentExecutionScope,
    sessionKey: timelineSessionKey,
    sessionID: timelineSessionID,
    sync,
    sdk,
    wantsReview,
    turnDiffs,
    artifactDiffs: () => (timelineDiffs().length > 0 ? timelineDiffs() : turnDiffs()),
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
    hasTodoCache: (id) => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined,
    syncSession: (id, options) => sync.session.sync(id, options),
    syncTodo: (id, options) => sync.session.todo(id, options),
    emitRendererDiagnostic,
  })

  useSessionVcsRefresh({
    directory: () => sdk.directory,
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

  type SyncStore = typeof sync.data
  const draftFrom = (source: { directory: string; store: SyncStore }, id: string) =>
    extractPromptFromParts(source.store.part[id] ?? [], {
      directory: source.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draftFrom({ directory: sdk.directory, store: sync.data }, id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  type SyncSetter = typeof sync.set
  const merge = (setStore: SyncSetter, next: NonNullable<ReturnType<typeof timeline.routeInfo>>) =>
    setStore("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (
    setStore: SyncSetter,
    sessionID: string,
    next: NonNullable<ReturnType<typeof timeline.routeInfo>>["revert"],
  ) =>
    setStore("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

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
    lineText: line,
    prompt,
    sync,
    snapshot: () => {
      const directory = sdk.directory
      const handle = sync.retainDirectory(directory)
      const scope = currentExecutionScope()
      return {
        scope,
        currentScope: currentExecutionScope,
        client: sdk.createClient({ directory, throwOnError: true }),
        store: handle.store,
        setStore: handle.setStore,
        prompt: prompt.current().slice(),
        promptScope: promptScopeForSession({
          routeDir: params.dir,
          routeDirectory: directory,
          targetDirectory: directory,
          sessionID: timelineSessionID(),
        }),
        release: handle.release,
        directory,
      }
    },
    actionReady: sessionActionReady,
    halt: haltWithSnapshot,
    draft: draftFrom,
    fail,
    merge,
    roll,
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

  const renderComposerRegion = (
    variant: "session" | "home",
    ctx?: {
      onModeChange: (mode: "normal" | "shell") => void
      selectedSkill: () => PawworkSkillName | undefined
    },
  ) => (
    <SessionPageComposerRegion
      variant={variant}
      state={composer}
      ready={!deferRender() && (variant === "home" ? timelineMessagesReady() : sessionActionReady())}
      actionReady={variant === "home" ? workspaceSubmitReady() : submitReady()}
      abortReady={variant === "home" ? true : sessionActionReady()}
      displaySessionID={variant === "session" ? timelineSessionID() : undefined}
      displaySessionKey={variant === "session" && timelineSessionID() ? timelineSessionKey() : undefined}
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
      selectedSkill={ctx?.selectedSkill}
      followup={
        variant === "session" && timelineSessionID() && submitReady() && !timelineIsChildSession()
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

  const retryOpenRouteSession = () => {
    const id = params.id
    if (!id) return
    void sync.session.sync(id, { force: true })
  }

  const openNewRouteSession = () => {
    const directory = decode64(params.dir)
    if (!directory) return
    shellSurface.openNewSession(directory)
  }

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
      onRetryOpenSession={retryOpenRouteSession}
      onOpenNewSession={openNewRouteSession}
      composerSession={renderComposerRegion("session")}
      composerHome={(ctx) => renderComposerRegion("home", ctx)}
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
