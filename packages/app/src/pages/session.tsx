import type { UserMessage } from "@opencode-ai/sdk/v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  onCleanup,
  Show,
  Match,
  Switch,
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
import { Tabs } from "@opencode-ai/ui/tabs"
import { showToast } from "@opencode-ai/ui/toast"
import { useLocation, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { buildDesktopContext } from "@/utils/desktop-context"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import { createSessionTabs, createSizing } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { useSessionLayout } from "@/pages/session/session-layout"
import {
  emptyMessages,
  emptyUserMessages,
  readSessionMessages,
  readUserMessages,
} from "@/pages/session/session-messages"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { createSessionRunning, isSessionRunning } from "@/pages/session/session-running-state"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { createSessionViewController } from "@/pages/session/session-view-controller"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { createSessionCommentContext } from "@/pages/session/use-session-comment-context"
import { useSessionDesktopContext } from "@/pages/session/use-session-desktop-context"
import { createSessionFollowups } from "@/pages/session/use-session-followups"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import { useSessionKeyboardFocus } from "@/pages/session/use-session-keyboard-focus"
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

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    scrollGesture: 0,
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
    messageId: undefined as string | undefined,
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

  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined

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

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scrollDock.scroller()
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = timelineVisibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  let inputRef!: HTMLDivElement
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scrollDock.scroller()
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on([() => sdk.directory, () => params.id] as const, ([, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(sdk.directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()
      untrack(() => {
        void sync.session.sync(id)
      })

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true })
          })
        }, 0)
      })
    }),
  )

  createEffect(
    on(
      () => {
        const id = timelineSessionID()
        return [
          sdk.directory,
          id,
          id ? (sync.data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk.directory !== dir || timelineSessionID() !== id) return
            untrack(() => {
              void sync.session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => timelineVisibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

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

  useSessionKeyboardFocus({
    blocked: composer.blocked,
    dialogActive: () => !!dialog.active,
    inputRef: () => inputRef,
    isChildSession: timelineIsChildSession,
    markScrollGesture,
    terminalActive: terminal.active,
    terminalOpened: () => view().terminal.opened(),
  })

  const focusInput = () => {
    if (timelineIsChildSession()) return
    inputRef?.focus()
  }

  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
  })

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

  const scrollDock = createSessionScrollDock({
    clearMessageHash: () => clearMessageHash(),
    clearActiveMessage: () => setStore("messageId", undefined),
    fill: () => fill(),
  })
  const autoScroll = scrollDock.autoScroll
  const resumeScroll = scrollDock.resumeScroll
  const scheduleScrollState = scrollDock.scheduleScrollState
  const setScrollRef = scrollDock.setScrollRef

  const markUserScroll = () => {
    scrollMark += 1
  }

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
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    setTurnStart: historyWindow.setTurnStart,
    autoScroll,
    scroller: scrollDock.scroller,
    anchor,
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onCleanup(() => {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  const renderComposerRegion = (
    variant: "session" | "home",
    ctx?: {
      onModeChange: (mode: "normal" | "shell") => void
      selectedSkill: () => PawworkSkillName | undefined
    },
  ) => (
    <SessionComposerRegion
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
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                  {reviewState.hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewState.reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        {/* Session panel */}
        <div class="@container relative min-w-[24rem] flex flex-col min-h-0 h-full bg-background-stronger flex-1">
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id}>
                <Show when={timelineSessionID()}>
                  <MessageTimeline
                    sessionID={timelineSessionID()!}
                    sessionKey={timelineSessionKey()}
                    sessionMessages={timelineMessages()}
                    mobileChanges={mobileChanges()}
                    mobileFallback={reviewPanel.mobileFallback()}
                    actions={actions}
                    scroll={scrollDock.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={markUserScroll}
                    onTurnBackfillScroll={historyWindow.onScrollerScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    centered={centered()}
                    setContentRef={(el) => {
                      scrollDock.setContentRef(el)
                    }}
                    turnStart={historyWindow.turnStart()}
                    historyMore={timelineHistoryMore()}
                    historyLoading={timelineHistoryLoading()}
                    onLoadEarlier={() => {
                      void historyWindow.loadAndReveal()
                    }}
                    renderedUserMessages={historyWindow.renderedUserMessages()}
                    anchor={anchor}
                  />
                </Show>
              </Match>
              <Match when={true}>
                <NewSessionView composer={(ctx) => renderComposerRegion("home", ctx)} />
              </Match>
            </Switch>
          </div>
          <Show when={params.id}>{renderComposerRegion("session")}</Show>
        </div>

        <SessionSidePanel
          canReview={canReview}
          diffs={reviewPanel.diffs}
          hasReview={reviewPanel.hasReview}
          reviewCount={reviewPanel.reviewCount}
          reviewPanel={reviewPanel.reviewPanel}
          files={reviewPanel.files}
          terminalPanel={() => <TerminalPanel embedded />}
          size={size}
        />
      </div>

      <Show when={!isDesktop()}>
        <TerminalPanel />
      </Show>
    </div>
  )
}
