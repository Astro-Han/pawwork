import { onCleanup, onMount } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { getFilename } from "@opencode-ai/util/path"
import type { Event, Part, PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import type { NotifyLevel } from "@/context/settings"
import { workspaceKey } from "./helpers"

type LayoutSession = Pick<Session, "id" | "parentID" | "title">

type LayoutSdkEvent = {
  name: string
  details?: Event
}

type LayoutSdkEventCopyKey =
  | "common.requestFailed"
  | "command.session.new"
  | "notification.permission.title"
  | "notification.permission.description"
  | "notification.question.title"
  | "notification.question.description"

type LayoutSdkEventCopy = {
  t(key: LayoutSdkEventCopyKey, params?: Record<string, string | number | boolean>): string
}

type QuestionNotificationPart = Pick<Part, "type"> & {
  tool?: string
  state?: {
    status?: string
    metadata?: {
      externalResultReady?: unknown
    }
  }
}

type LayoutSdkEventEffectsInput = {
  route: {
    currentDirectory: () => string
    currentSessionID: () => string | undefined
    sessionHref: (directory: string, sessionID: string) => string
  }
  sdk: {
    sessions: (directory: string) => readonly LayoutSession[]
  }
  settings: {
    notify: {
      level: () => NotifyLevel
    }
  }
  permission: {
    autoResponds: (request: PermissionRequest, directory: string) => boolean
  }
  effects: {
    notify: (title: string, description?: string, href?: string) => Promise<void> | void
    playSound: (soundID: string) => unknown
    setBusy: (directory: string, value: boolean) => void
    worktreeReady: (directory: string) => void
    worktreeFailed: (directory: string, message: string) => void
  }
  copy: LayoutSdkEventCopy
  cooldownMs?: number
  now?: () => number
}

type LayoutSdkEventHookInput = Omit<LayoutSdkEventEffectsInput, "sdk"> & {
  sdk: LayoutSdkEventEffectsInput["sdk"] & {
    listen: (handler: (event: LayoutSdkEvent) => void) => () => void
  }
}

export function permissionSessionKey(directory: string, sessionID: string) {
  return `${directory}:${sessionID}`
}

export function questionCallKey(directory: string, sessionID: string, partID: string) {
  return `${directory}:${sessionID}:${partID}`
}

export function sessionNotificationHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

export function shouldThrottlePermissionAlert(lastAlerted: number | undefined, now: number, cooldownMs: number) {
  if (lastAlerted === undefined) return false
  return now - lastAlerted < cooldownMs
}

export function questionNotificationAction(part: QuestionNotificationPart): "ignore" | "reset" | "notify" {
  if (part.type !== "tool" || part.tool !== "question") return "ignore"
  // Terminal updates may not be followed by message.part.removed, so they must
  // clear the running-question dedupe entry themselves.
  if (part.state?.status !== "running") return "reset"
  if (part.state.metadata?.externalResultReady !== true) return "ignore"
  return "notify"
}

export function isCurrentOrDescendantSession(input: {
  directory: string
  sessionID: string
  currentDirectory: string
  currentSessionID: string | undefined
  sessions: readonly Pick<Session, "id" | "parentID">[]
}) {
  const currentSession = input.currentSessionID
  if (!currentSession) return false
  if (workspaceKey(input.directory) !== workspaceKey(input.currentDirectory)) return false
  if (input.sessionID === currentSession) return true

  // Walk ancestors so a child-agent question stays quiet while its parent
  // session page is already visible.
  const byID = new Map(input.sessions.map((session) => [session.id, session]))
  let cursor: string | undefined = byID.get(input.sessionID)?.parentID
  const seen = new Set<string>([input.sessionID])

  while (cursor) {
    if (cursor === currentSession) return true
    if (seen.has(cursor)) break
    seen.add(cursor)
    cursor = byID.get(cursor)?.parentID
  }

  return false
}

function currentRouteVisibility(
  input: LayoutSdkEventEffectsInput,
  directory: string,
  sessionID: string,
): { visible: boolean; sessions?: readonly LayoutSession[] } {
  if (typeof document !== "undefined" && !document.hasFocus()) return { visible: false }
  const currentSessionID = input.route.currentSessionID()
  if (!currentSessionID) return { visible: false }

  const currentDirectory = input.route.currentDirectory()
  if (workspaceKey(directory) !== workspaceKey(currentDirectory)) return { visible: false }
  if (sessionID === currentSessionID) return { visible: true }

  const sessions = input.sdk.sessions(directory)
  return {
    visible: isCurrentOrDescendantSession({
      directory,
      sessionID,
      currentDirectory,
      currentSessionID,
      sessions,
    }),
    sessions,
  }
}

function titleFromSessions(
  sessions: readonly LayoutSession[] | undefined,
  sessionID: string,
  fallback: string,
) {
  return sessions?.find((item) => item.id === sessionID)?.title ?? fallback
}

export function createSDKNotificationEventHandler(input: LayoutSdkEventEffectsInput) {
  const alertedAtBySession = new Map<string, number>()
  const alertedQuestionCalls = new Set<string>()
  const cooldownMs = input.cooldownMs ?? 5000
  const now = input.now ?? Date.now

  return (event: LayoutSdkEvent) => {
    const details = event.details
    if (!details) return

    if (details.type === "worktree.ready") {
      input.effects.setBusy(event.name, false)
      input.effects.worktreeReady(event.name)
      return
    }

    if (details.type === "worktree.failed") {
      input.effects.setBusy(event.name, false)
      input.effects.worktreeFailed(event.name, details.properties?.message ?? input.copy.t("common.requestFailed"))
      return
    }

    if (details.type === "permission.replied") {
      alertedAtBySession.delete(permissionSessionKey(event.name, details.properties.sessionID))
      return
    }

    if (details.type === "message.part.updated") {
      const directory = event.name
      const { sessionID, part } = details.properties
      const action = questionNotificationAction(part)
      if (action === "ignore") return

      const callKey = questionCallKey(directory, sessionID, part.id)
      if (action === "reset") {
        alertedQuestionCalls.delete(callKey)
        return
      }

      if (alertedQuestionCalls.has(callKey)) return
      alertedQuestionCalls.add(callKey)

      const level = input.settings.notify.level()
      if (level === "never") return

      const visibility = currentRouteVisibility(input, directory, sessionID)
      if (level === "unfocused" && visibility.visible) return

      void input.effects.playSound("notify")

      const sessions = visibility.sessions ?? input.sdk.sessions(directory)
      const sessionTitle = titleFromSessions(sessions, sessionID, input.copy.t("command.session.new"))
      const projectName = getFilename(directory)
      void input.effects.notify(
        input.copy.t("notification.question.title"),
        input.copy.t("notification.question.description", { sessionTitle, projectName }),
        input.route.sessionHref(directory, sessionID),
      )
      return
    }

    if (details.type === "message.part.removed") {
      const { sessionID, partID } = details.properties
      alertedQuestionCalls.delete(questionCallKey(event.name, sessionID, partID))
      return
    }

    if (details.type !== "permission.asked") return
    const directory = event.name
    const props = details.properties
    if (input.permission.autoResponds(props, directory)) return

    const sessionKey = permissionSessionKey(directory, props.sessionID)

    const lastAlerted = alertedAtBySession.get(sessionKey)
    const currentTime = now()
    if (shouldThrottlePermissionAlert(lastAlerted, currentTime, cooldownMs)) return
    alertedAtBySession.set(sessionKey, currentTime)

    const level = input.settings.notify.level()
    if (level === "never") return

    const visibility = currentRouteVisibility(input, directory, props.sessionID)
    if (level === "unfocused" && visibility.visible) return

    void input.effects.playSound("notify")

    const sessions = visibility.sessions ?? input.sdk.sessions(directory)
    const sessionTitle = titleFromSessions(sessions, props.sessionID, input.copy.t("command.session.new"))
    const projectName = getFilename(directory)
    void input.effects.notify(
      input.copy.t("notification.permission.title"),
      input.copy.t("notification.permission.description", { sessionTitle, projectName }),
      input.route.sessionHref(directory, props.sessionID),
    )
  }
}

export function useSDKNotificationToasts(input: LayoutSdkEventHookInput) {
  onMount(() => {
    const unsub = input.sdk.listen(createSDKNotificationEventHandler(input))
    onCleanup(unsub)
  })
}
