import { For, createEffect, createMemo, on, onCleanup, Show, Index, type JSX, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AssistantMessage, Message as MessageType, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { getFilename } from "@opencode-ai/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { taskDescription } from "@/pages/session/task-description"
import { createSessionRunning } from "@/pages/session/session-running-state"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionKey } from "@/pages/session/session-layout"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { makeTimer } from "@solid-primitives/timer"
import { webSearchRecoveryToast } from "./websearch-toasts"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

function isWebSearchToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool" && part.tool === "websearch"
}

function isPendingWebSearchToolPart(part: Part) {
  return isWebSearchToolPart(part) && (part.state.status === "pending" || part.state.status === "running")
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }
type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

export { taskDescription }

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, input.config.init)
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  sessionID: string
  sessionKey: string
  sessionMessages: MessageType[]
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const shellSurface = useShellSurface()
  const { params } = useSessionKey()
  const platform = usePlatform()
  const server = useServer()
  // Export hits the embedded sidecar via main-process IPC. When the user has switched the
  // active server to a remote HTTP/SSH target, the sidecar holds different data than the UI;
  // hide the action rather than ship a misleading export.
  const exportAvailable = createMemo(() => !!platform.exportSession && server.current?.type === "sidecar")

  const rendered = createMemo(() => props.renderedUserMessages.map((message) => message.id))
  const sessionKey = createMemo(() => props.sessionKey)
  const sessionID = createMemo(() => props.sessionID)
  const sessionMessages = createMemo(() => props.sessionMessages)
  const webSearchToastSurfaced = new Set<string>()
  const webSearchPartCursor = new Map<string, number>()
  const webSearchPendingParts = new Map<string, Set<string>>()
  let webSearchToastSessionID: string | undefined

  createEffect(() => {
    const id = sessionID()
    if (id !== webSearchToastSessionID) {
      webSearchToastSessionID = id
      webSearchToastSurfaced.clear()
      webSearchPartCursor.clear()
      webSearchPendingParts.clear()
    }
    for (const message of sessionMessages()) {
      const parts = sync.data.part[message.id] ?? []
      const start = webSearchPartCursor.get(message.id) ?? 0
      const pending = webSearchPendingParts.get(message.id) ?? new Set<string>()
      const candidates = [...parts.slice(start), ...parts.slice(0, start).filter((part) => pending.has(part.id))]
      for (const part of candidates) {
        if (isPendingWebSearchToolPart(part)) pending.add(part.id)
        else pending.delete(part.id)
        const toast = webSearchRecoveryToast(part, { surfaced: webSearchToastSurfaced })
        if (!toast) continue
        showToast({
          title: language.t(toast.titleKey),
          description: language.t(toast.descriptionKey),
          variant: "error",
          actions: [
            {
              label: language.t(toast.actionKey),
              onClick: () => shellSurface.openSettings(),
            },
          ],
        })
      }
      webSearchPartCursor.set(message.id, parts.length)
      if (pending.size > 0) webSearchPendingParts.set(message.id, pending)
      else webSearchPendingParts.delete(message.id)
    }
  })
  const pending = createMemo(() => {
    const messages = sessionMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const working = createSessionRunning(sessionStatus, sessionMessages)
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = working() ? pending()?.parentID : undefined
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus() ?? idle
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  // Match the initial window cap so session switches do not reveal the window in partial batches.
  const stageCfg = { init: 10, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey: () => props.sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  let more: HTMLButtonElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const onExport = async () => {
    const id = sessionID()
    if (!id || !platform.exportSession) return

    // Build a slug-based default filename. Falls back to id suffix if slug is missing.
    const slugSource = info()?.slug ?? id
    // Allow Unicode letters/numbers (CJK titles work) but strip filesystem-hostile chars.
    // If sanitization produces an empty/dash-only string, fall back to the id suffix.
    const sanitized = slugSource.replace(/[\\/:*?"<>|]/g, "-").slice(0, 32)
    const slug = /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : id.slice(-8)
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "")
    const defaultName = `pawwork-session-${slug}-${stamp}.json`

    let result: { ok: true; path: string } | { ok: false; error: string }
    try {
      result = await platform.exportSession(id, sdk.directory, defaultName, language.t("session.export.action.export"))
    } catch (err) {
      showToast({
        title: language.t("session.export.error.failed"),
        description: errorMessage(err),
        variant: "error",
      })
      return
    }
    if (!result.ok) {
      if (result.error === "cancelled") return
      showToast({
        title: language.t("session.export.error.failed"),
        description: result.error,
        variant: "error",
      })
      return
    }
    showToast({
      title: language.t("session.export.success"),
      description: result.path,
    })
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    if (parentID) {
      navigate(`/${params.dir}/session/${parentID}`)
      return
    }
    if (nextSessionID) {
      navigate(`/${params.dir}/session/${nextSessionID}`)
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync.session.get(sessionID)
    if (!session) return false

    const sessions = (sync.data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk.client.session
      .delete({ sessionID })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    sync.set(
      produce((draft) => {
        const removed = new Set<string>([sessionID])

        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }

        const stack = [sessionID]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue

          const children = byParent.get(parentID)
          if (!children) continue

          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }

        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync.session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-13-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--composer-dock-height,0px)+2.5rem)] z-[60] pointer-events-none transition-[opacity,transform] duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          <button
            type="button"
            class="pointer-events-auto size-8 rounded-full border border-border-weaker-base bg-surface-raised-stronger-non-alpha flex items-center justify-center cursor-pointer p-0 transition-colors hover:bg-surface-raised-base-hover hover:border-border-weak-base hover:[--icon-base:var(--icon-hover)]"
            style={{ "box-shadow": "var(--shadow-floating)" }}
            onClick={props.onResumeScroll}
            aria-label={language.t("session.messages.jumpToLatest")}
          >
            <Icon name="chevron-down" size="small" />
          </button>
        </div>
        <ScrollView
          viewportRef={props.setScrollRef}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            props.onAutoScrollHandleScroll()
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": "0px",
            "--sticky-accordion-top": "0px",
          }}
        >
          <div ref={props.setContentRef} class="min-w-0 w-full">
            <div
              role="log"
              data-slot="session-turn-list"
              class="flex flex-col items-start justify-start pb-16 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-13-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(messageID) => {
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (c, i) =>
                          c.path === b[i].path &&
                          c.comment === b[i].comment &&
                          c.selection?.startLine === b[i].selection?.startLine &&
                          c.selection?.endLine === b[i].selection?.endLine,
                      ),
                  })
                  const commentCount = createMemo(() => comments().length)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-200 2xl:max-w-[1000px]": props.centered,
                      }}
                      style={{
                        "content-visibility": active() ? undefined : "auto",
                        "contain-intrinsic-size": active() ? undefined : "auto 500px",
                      }}
                    >
                      <Show when={commentCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <Show when={comment()}>
                                      {(c) => (
                                        <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak-base bg-background-stronger px-2.5 py-2">
                                          <div class="flex items-center gap-1.5 min-w-0 text-13-medium text-text-strong">
                                            <FileIcon
                                              node={{ path: c().path, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{getFilename(c().path)}</span>
                                            <Show when={c().selection}>
                                              {(selection) => (
                                                <span class="shrink-0 text-text-weak">
                                                  {selection().startLine === selection().endLine
                                                    ? `:${selection().startLine}`
                                                    : `:${selection().startLine}-${selection().endLine}`}
                                                </span>
                                              )}
                                            </Show>
                                          </div>
                                          <div class="pt-1 text-13-regular text-text-strong whitespace-pre-wrap break-words">
                                            {c().comment}
                                          </div>
                                        </div>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        messages={sessionMessages()}
                        actions={props.actions}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
