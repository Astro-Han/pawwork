import type { LocalProject } from "@/context/layout"
import { getFilename } from "@opencode-ai/util/path"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { effectiveWorkspaceOrder, workspaceKey } from "./helpers"

type ProjectLike = {
  name?: string
  worktree: string
}

type SessionLike = {
  id: string
  created: number
  projectLabel: string
}

type SessionTimeLike = {
  activityAt?: number
  time?: {
    created?: number
    updated?: number
  }
}

type MessageTimeLike = {
  id?: string
  role?: string
  time?: {
    created?: number
  }
}

type PartTimeLike = {
  type?: string
  synthetic?: boolean
}

type SidebarRowSessionLike = SessionTimeLike & {
  id: string
  directory: string
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

const shortenHome = (value: string, home?: string) => {
  if (!home) return value
  const normalized = home.endsWith("/") ? home : `${home}/`
  if (!value.startsWith(normalized)) return value
  return `~/${value.slice(normalized.length)}`
}

export function resolvePawworkProjectLabels<T extends ProjectLike>(projects: T[], home?: string) {
  const counts = new Map<string, number>()
  for (const project of projects) {
    const label = project.name || getFilename(project.worktree)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  const labels = new Map<string, string>()
  for (const project of projects) {
    const label = project.name || getFilename(project.worktree)
    labels.set(project.worktree, (counts.get(label) ?? 0) > 1 ? shortenHome(project.worktree, home) : label)
  }
  return labels
}

export function sortPawworkSidebarSessions<T extends SessionLike>(sessions: T[]) {
  return sessions.slice().sort((a, b) => {
    const created = b.created - a.created
    if (created !== 0) return created
    const project = a.projectLabel.localeCompare(b.projectLabel)
    if (project !== 0) return project
    return a.id.localeCompare(b.id)
  })
}

const isActivityEligibleUserMessage = (parts: PartTimeLike[] | undefined) => {
  if (!parts) return false
  if (parts.some((part) => part.type === "compaction")) return false
  const hasSynthetic = parts.some((part) => part.synthetic === true)
  if (!hasSynthetic) return true
  return parts.some((part) => part.synthetic !== true)
}

const latestLoadedUserMessageTime = (
  messages: MessageTimeLike[] | undefined,
  partsForMessage: ((messageID: string) => PartTimeLike[] | undefined) | undefined,
  requireEligibility: boolean,
) => {
  let latestLoadedUserAt: number | undefined
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages?.[i]
    if (message?.role !== "user") continue
    const parts = message.id ? partsForMessage?.(message.id) : undefined
    if (requireEligibility || parts) {
      if (!parts || !isActivityEligibleUserMessage(parts)) continue
    }
    const created = message.time?.created
    if (isFiniteNumber(created)) {
      latestLoadedUserAt = created
      break
    }
  }
  return latestLoadedUserAt
}

export function pawworkSidebarSessionTime(
  session: SessionTimeLike,
  messages?: MessageTimeLike[],
  partsForMessage?: (messageID: string) => PartTimeLike[] | undefined,
) {
  if (isFiniteNumber(session.activityAt)) {
    const latestEligibleLoadedUserAt = latestLoadedUserMessageTime(messages, partsForMessage, true)
    return latestEligibleLoadedUserAt === undefined
      ? session.activityAt
      : Math.max(session.activityAt, latestEligibleLoadedUserAt)
  }
  const latestLoadedUserAt = latestLoadedUserMessageTime(messages, partsForMessage, false)
  if (latestLoadedUserAt !== undefined) return latestLoadedUserAt
  const sessionCreated = session.time?.created
  return isFiniteNumber(sessionCreated) ? sessionCreated : 0
}

export function buildPawworkSidebarSessionRows<T extends SidebarRowSessionLike>(
  sessions: T[],
  input: {
    slugForDirectory: (directory: string) => string
    projectLabelForSession: (session: T) => string
    messagesForSession?: (session: T) => MessageTimeLike[] | undefined
    partsForMessage?: (session: T, messageID: string) => PartTimeLike[] | undefined
  },
) {
  return sessions.map((session) => ({
    session,
    slug: input.slugForDirectory(session.directory),
    projectLabel: input.projectLabelForSession(session),
    created: pawworkSidebarSessionTime(
      session,
      input.messagesForSession?.(session),
      input.partsForMessage ? (messageID) => input.partsForMessage?.(session, messageID) : undefined,
    ),
  }))
}

export function pawworkSessionDirectories(input: {
  project: LocalProject | undefined
  activeProjectWorktree?: string
  currentDirectory?: string
  workspaceOrder?: string[]
}) {
  const project = input.project
  if (!project) return []

  const local = project.worktree
  const dirs = [local, ...(project.sandboxes ?? [])]
  const directory =
    input.activeProjectWorktree && workspaceKey(input.activeProjectWorktree) === workspaceKey(project.worktree)
      ? input.currentDirectory
      : undefined
  const extra =
    directory &&
    workspaceKey(directory) !== workspaceKey(local) &&
    !dirs.some((item) => workspaceKey(item) === workspaceKey(directory))
      ? directory
      : undefined
  const pending = extra ? WorktreeState.get(extra)?.status === "pending" : false

  const ordered = effectiveWorkspaceOrder(local, dirs, input.workspaceOrder)
  if (pending && extra) return [local, extra, ...ordered.filter((item) => item !== local)]
  if (!extra) return ordered
  if (pending) return ordered
  return [...ordered, extra]
}
