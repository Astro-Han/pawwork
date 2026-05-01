import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  onCleanup,
  createMemo,
  createEffect,
  createComputed,
  on,
  untrack,
} from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { useLocal } from "@/context/local"
import { useFile } from "@/context/file"
import { createStore } from "solid-js/store"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocation, useSearchParams } from "@solidjs/router"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"
import { useComments } from "@/context/comments"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { buildDesktopContext } from "@/utils/desktop-context"
import { createSessionComposerState } from "@/pages/session/composer"
import { createSessionTabs, createSizing } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  emptyMessages,
  emptyUserMessages,
  readSessionMessages,
  readUserMessages,
} from "@/pages/session/session-messages"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionPageComposerRegion } from "@/pages/session/session-composer-region"
import { SessionMainView } from "@/pages/session/session-main-view"
import { createSessionRunning, isSessionRunning } from "@/pages/session/session-running-state"
import { createSessionViewController } from "@/pages/session/session-view-controller"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { createSessionActiveMessage } from "@/pages/session/use-session-active-message"
import { createSessionCommentContext } from "@/pages/session/use-session-comment-context"
import { useSessionDesktopContext } from "@/pages/session/use-session-desktop-context"
import { createSessionFollowups } from "@/pages/session/use-session-followups"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import { useSessionKeyboardFocus } from "@/pages/session/use-session-keyboard-focus"
import { useSessionRefreshEffects } from "@/pages/session/use-session-refresh-effects"
import { createSessionRevert } from "@/pages/session/use-session-revert"
import { createSessionReviewPanel } from "@/pages/session/use-session-review-panel"
import { createSessionReviewState } from "@/pages/session/use-session-review-state"
import { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"
import { diffs as list } from "@/utils/diffs"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
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
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const { params, sessionKey, tabs, view } = useSessionLayout()

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

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopSidePanelOpen = createMemo(() => isDesktop() && view().sidePanel.opened())
  const centered = createMemo(() => isDesktop())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    view().sidePanel.openTab("review")
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync.data.session_diff[params.id]) : []))
  const sessionCount = createMemo(() => Math.max(info()?.summary?.files ?? 0, diffs().length))
  const hasSessionReview = createMemo(() => sessionCount() > 0)
  const canReview = createMemo(() => !!sync.project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const sessionView = createSessionViewController({
    directory: () => params.dir ?? "",
    routeSessionID: () => params.id,
    routeMessagesReady: messagesReady,
  })
  const timelineSessionID = sessionView.visible.id
  const timelineSessionKey = sessionView.visible.key
  const timelineInfo = createMemo(() => {
    const id = timelineSessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const timelineIsChildSession = createMemo(() => !!timelineInfo()?.parentID)
  const composer = createSessionComposerState({ sessionID: timelineSessionID })
  const timelineMessages = createMemo(
    () => {
      const id = timelineSessionID()
      return readSessionMessages(id ? sync.data.message[id] : undefined)
    },
    emptyMessages,
    { equals: same },
  )
  const timelineMessagesReady = sessionView.visible.ready
  const timelineDiffs = createMemo(() => {
    const id = timelineSessionID()
    if (!id) return []
    return list(sync.data.session_diff[id])
  })
  const timelineUserMessages = createMemo(() => readUserMessages(timelineMessages()), emptyUserMessages, {
    equals: same,
  })
  const timelineRevertMessageID = createMemo(() => {
    const id = timelineSessionID()
    if (!id) return
    return sync.session.get(id)?.revert?.messageID
  })
  const timelineVisibleUserMessages = createMemo(
    () => {
      const revert = timelineRevertMessageID()
      if (!revert) return timelineUserMessages()
      return timelineUserMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const timelineHistoryMore = createMemo(() => {
    const id = timelineSessionID()
    if (!id) return false
    return sync.session.history.more(id)
  })
  const timelineHistoryLoading = createMemo(() => {
    const id = timelineSessionID()
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const lastUserMessage = createMemo(() => timelineVisibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    mobileTab: "session" as "session" | "changes",
    newSessionWorktree: "main",
    deferRender: false,
  })

  createComputed((prev) => {
    const key = timelineSessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, timelineSessionKey())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopSidePanelOpen() && view().sidePanel.tab() === "review" && activeTab() === "review"
      : mobileChanges(),
  )
  const reviewState = createSessionReviewState({
    directory: sdk.directory,
    sessionKey,
    sessionID: timelineSessionID,
    sync,
    sdk,
    wantsReview,
    turnDiffs,
  })

  const refreshVcs = () => {
    reviewState.resetVcs()
    const mode = untrack(reviewState.vcsMode)
    if (!mode) return
    if (!untrack(wantsReview)) return
    void reviewState.loadVcs(mode, true)
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const anchor = (id: string) => `message-${id}`

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
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        reviewState.resetVcs()
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [sync.data.vcs?.branch, sync.data.vcs?.default_branch] as const,
      (next, prev) => {
        if (prev === undefined || same(next, prev)) return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const commentContext = createSessionCommentContext({
    attachmentLabel: () => language.t("common.attachment"),
    getFileContent: (path) => file.get(path)?.content?.content,
    comments,
    promptContext: prompt.context,
  })

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const focusInput = () => {
    if (timelineIsChildSession()) return
    inputRef?.focus()
  }

  const reviewPanel = createSessionReviewPanel({
    activeFileTab,
    canReview,
    comments,
    commentContext,
    deferRender: () => store.deferRender,
    file,
    isDesktop,
    language,
    reviewState,
    routeSessionID: () => params.id,
    sdk,
    sessionKey,
    sync,
    timelineDiffs,
    turnDiffs,
    view,
    wantsReview,
    openTab: tabs().open,
    setActiveTab: tabs().setActive,
  })

  let fillFrame: number | undefined

  let fill = () => {}
  let activeMessage!: ReturnType<typeof createSessionActiveMessage>

  const scrollDock = createSessionScrollDock({
    clearMessageHash: () => clearMessageHash(),
    clearActiveMessage: () => activeMessage?.clearActiveMessage(),
    fill: () => fill(),
  })
  const autoScroll = scrollDock.autoScroll
  const resumeScroll = scrollDock.resumeScroll
  const scheduleScrollState = scrollDock.scheduleScrollState
  const setScrollRef = scrollDock.setScrollRef

  activeMessage = createSessionActiveMessage({
    sessionKey,
    visibleUserMessages: timelineVisibleUserMessages,
    lastUserMessageID: () => timelineVisibleUserMessages().at(-1)?.id,
    scroller: scrollDock.scroller,
    resumeScroll,
    pauseAutoScroll: autoScroll.pause,
  })

  useSessionKeyboardFocus({
    blocked: composer.blocked,
    dialogActive: () => !!dialog.active,
    inputRef: () => inputRef,
    isChildSession: timelineIsChildSession,
    markScrollGesture: activeMessage.markScrollGesture,
    terminalActive: terminal.active,
    terminalOpened: () => view().terminal.opened(),
  })

  useSessionCommands({
    navigateMessageByOffset: activeMessage.navigateMessageByOffset,
    setActiveMessage: activeMessage.setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const historyWindow = createSessionHistoryWindow({
    sessionID: timelineSessionID,
    messagesReady: timelineMessagesReady,
    loaded: () => timelineMessages().length,
    visibleUserMessages: timelineVisibleUserMessages,
    historyMore: timelineHistoryMore,
    historyLoading: timelineHistoryLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: scrollDock.scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!timelineSessionID() || !timelineMessagesReady()) return
      if (autoScroll.userScrolled() || timelineHistoryLoading()) return

      const el = scrollDock.scroller()
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (historyWindow.turnStart() <= 0 && !timelineHistoryMore()) return

      void historyWindow.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          timelineSessionID(),
          timelineMessagesReady(),
          historyWindow.turnStart(),
          timelineHistoryMore(),
          timelineHistoryLoading(),
          autoScroll.userScrolled(),
          timelineVisibleUserMessages().length,
        ] as const,
      ([, id, ready, start, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (start <= 0 && !more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
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

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
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
  const busy = () => timelineRunning()

  const followups = createSessionFollowups({
    directory: sdk.directory,
    client: sdk.client,
    sessionID: timelineSessionID,
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

  const halt = (sessionID: string) =>
    isSessionRunning(sync.data.session_status[sessionID], sync.data.message[sessionID])
      ? sdk.client.session.abort({ sessionID }).catch(() => {})
      : Promise.resolve()

  const sessionRevert = createSessionRevert({
    sessionID: timelineSessionID,
    revertMessageID: timelineRevertMessageID,
    timelineUserMessages,
    lineText: line,
    prompt,
    sync,
    client: sdk.client,
    halt,
    draft,
    fail,
    merge,
    roll,
  })

  const actions = { revert: sessionRevert.revert }

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey: timelineSessionKey,
    sessionID: timelineSessionID,
    messagesReady: timelineMessagesReady,
    visibleUserMessages: timelineVisibleUserMessages,
    historyMore: timelineHistoryMore,
    historyLoading: timelineHistoryLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    turnStart: historyWindow.turnStart,
    currentMessageId: activeMessage.messageId,
    pendingMessage: activeMessage.pendingMessage,
    setPendingMessage: activeMessage.setPendingMessage,
    setActiveMessage: activeMessage.setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: scrollDock.scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })
  activeMessage.setScrollToMessage(scrollToMessage)

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onCleanup(() => {
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

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
      ready={!store.deferRender && timelineMessagesReady()}
      displaySessionID={variant === "session" ? timelineSessionID() : undefined}
      displaySessionKey={variant === "session" && timelineSessionID() ? timelineSessionKey() : undefined}
      centered={centered()}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree()}
      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
      onSubmit={() => {
        comments.clear()
        resumeScroll()
      }}
      onResponseSubmit={resumeScroll}
      onModeChange={ctx?.onModeChange}
      selectedSkill={ctx?.selectedSkill}
      followup={
        variant === "session" && timelineSessionID() && !timelineIsChildSession()
          ? {
              queue: followups.queueEnabled,
              items: followups.followupDock(),
              sending: followups.sendingFollowup(),
              edit: followups.editingFollowup(),
              onQueue: followups.queueFollowup,
              onAbort: () => {
                const id = timelineSessionID()
                if (!id) return
                followups.pause(id)
              },
              onSend: (id) => {
                const sessionID = timelineSessionID()
                if (!sessionID) return
                void followups.sendFollowup(sessionID, id, { manual: true })
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
              disabled: sessionRevert.reverting(),
              onRestore: sessionRevert.restore,
            }
          : undefined
      }
      setPromptDockRef={scrollDock.setPromptDockRef}
    />
  )

  return (
    <SessionMainView
      activeSessionID={params.id}
      isDesktop={isDesktop()}
      mobileTab={store.mobileTab}
      setMobileTab={(tab) => setStore("mobileTab", tab)}
      language={language}
      timelineSessionID={timelineSessionID()}
      timelineSessionKey={timelineSessionKey()}
      timelineMessages={timelineMessages()}
      mobileChanges={mobileChanges()}
      mobileFallback={reviewPanel.mobileFallback()}
      actions={actions}
      scroll={scrollDock.scroll}
      resumeScroll={resumeScroll}
      setScrollRef={setScrollRef}
      scheduleScrollState={scheduleScrollState}
      autoScroll={autoScroll}
      markScrollGesture={activeMessage.markScrollGesture}
      hasScrollGesture={activeMessage.hasScrollGesture}
      markUserScroll={activeMessage.markUserScroll}
      historyWindow={historyWindow}
      centered={centered()}
      setContentRef={scrollDock.setContentRef}
      historyMore={timelineHistoryMore()}
      historyLoading={timelineHistoryLoading()}
      anchor={anchor}
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
