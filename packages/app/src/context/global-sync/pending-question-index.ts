// The single source of truth for "which question tool calls are currently
// waiting on the user", projected across every directory the global event
// stream touches — including background projects that were never bootstrapped
// and so have no child store. It is a small live condition index, not a log:
// entries appear when a `question` part flips `externalResultReady` and retract
// on every removal path. The dock / sidebar "asking" pip render from child-store
// parts (the authoritative renderable truth for an open session); this index
// exists for the cross-project signals that parts cannot serve — the Dock badge
// count, session-trim preservation, and the rising-edge OS alert.
//
// Identity is (directory, askSessionID, messageID, callID): the same identity
// the server registry and POST /session/:id/tool/respond use. `partID` rides
// along only so a `message.part.removed` (which carries no callID) can retract.

import type { Part } from "@opencode-ai/sdk/v2/client"
import {
  pendingExternalResultQuestionFromPart,
  type PendingExternalResultQuestion,
} from "./external-result-question"

// One pending question keyed by its asking identity, plus the resolved root
// session it should be attributed to. `rootSessionID` is filled asynchronously
// at ingestion (a child agent's question is answered from — and badged on — its
// root session); it stays undefined until the walk resolves, and badge/preserve
// derivations fall back to `sessionID` so an unresolved entry still counts.
export type PendingQuestion = PendingExternalResultQuestion & { rootSessionID?: string }

// directory -> askSessionID -> questions owned by that session
export type PendingQuestionIndex = {
  [directory: string]: { [sessionID: string]: PendingQuestion[] }
}

export function pendingQuestionFromPart(part: Part): PendingExternalResultQuestion | undefined {
  return pendingExternalResultQuestionFromPart(part)
}

// Upsert one question under (directory, sessionID). Returns true only when the
// (messageID:callID) identity is newly added — the rising-edge signal the OS
// alert keys off, so a stream of `message.part.updated` for the same call
// alerts exactly once. Preserves an already-resolved `rootSessionID` when the
// same identity is re-upserted (e.g. a later part update) so a resolved
// attribution is not dropped back to unresolved.
export function upsertPendingQuestion(
  index: PendingQuestionIndex,
  directory: string,
  question: PendingQuestion,
): boolean {
  const bySession = index[directory] ?? (index[directory] = {})
  const list = bySession[question.sessionID] ?? []
  const at = list.findIndex((item) => item.id === question.id)
  if (at === -1) {
    bySession[question.sessionID] = [...list, question].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return true
  }
  const next = list.slice()
  next[at] = { ...question, rootSessionID: question.rootSessionID ?? list[at].rootSessionID }
  bySession[question.sessionID] = next
  return false
}

// Set the resolved root on an existing entry (post async walk). No-op if the
// entry retracted while the walk was in flight.
export function setPendingQuestionRoot(
  index: PendingQuestionIndex,
  directory: string,
  sessionID: string,
  id: string,
  rootSessionID: string,
): void {
  const list = index[directory]?.[sessionID]
  if (!list) return
  const at = list.findIndex((item) => item.id === id)
  if (at === -1) return
  const next = list.slice()
  next[at] = { ...next[at], rootSessionID }
  index[directory][sessionID] = next
}

type RemoveMatch = {
  directory?: string
  sessionID?: string
  messageID?: string
  partID?: string
}

// Retract every entry matching the (optional) fields. A bare `directory`
// sweeps the whole project; `directory + sessionID` a deleted/archived session;
// `messageID` a removed message; `partID` a removed part. Returns the removed
// entries so the caller can cancel any in-flight root resolution for them.
export function removePendingQuestions(index: PendingQuestionIndex, match: RemoveMatch): PendingQuestion[] {
  const removed: PendingQuestion[] = []
  const directories = match.directory ? [match.directory] : Object.keys(index)
  for (const directory of directories) {
    const bySession = index[directory]
    if (!bySession) continue
    const sessionIDs = match.sessionID ? [match.sessionID] : Object.keys(bySession)
    for (const sessionID of sessionIDs) {
      const list = bySession[sessionID]
      if (!list) continue
      const kept: PendingQuestion[] = []
      for (const question of list) {
        const hit =
          (match.messageID === undefined || question.messageID === match.messageID) &&
          (match.partID === undefined || question.partID === match.partID)
        if (hit) removed.push(question)
        else kept.push(question)
      }
      if (kept.length === list.length) continue
      if (kept.length > 0) bySession[sessionID] = kept
      else delete bySession[sessionID]
    }
    if (Object.keys(bySession).length === 0) delete index[directory]
  }
  return removed
}

// Replace a directory's whole pending set with the authoritative snapshot from
// GET /external-result (hydrate / reconnect). Carries forward an already
// resolved `rootSessionID` for identities that survive, so a reconcile does not
// re-trigger a root walk for questions that were already attributed. Returns
// the identities that were dropped (resolved while the app was away) so the
// caller can release their resolution state.
export function reconcileDirectoryPending(
  index: PendingQuestionIndex,
  directory: string,
  next: PendingQuestion[],
): string[] {
  const previous = index[directory] ?? {}
  const priorRoot = new Map<string, string>()
  for (const list of Object.values(previous)) {
    for (const question of list ?? []) {
      if (question.rootSessionID) priorRoot.set(question.id, question.rootSessionID)
    }
  }
  const keptIDs = new Set<string>()
  const bySession: { [sessionID: string]: PendingQuestion[] } = {}
  for (const question of next) {
    keptIDs.add(question.id)
    const merged = { ...question, rootSessionID: question.rootSessionID ?? priorRoot.get(question.id) }
    const list = bySession[question.sessionID] ?? (bySession[question.sessionID] = [])
    list.push(merged)
  }
  for (const list of Object.values(bySession)) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
  const dropped: string[] = []
  for (const id of priorRoot.keys()) if (!keptIDs.has(id)) dropped.push(id)
  for (const list of Object.values(previous)) {
    for (const question of list ?? []) if (!keptIDs.has(question.id) && !priorRoot.has(question.id)) dropped.push(question.id)
  }
  if (next.length > 0) index[directory] = bySession
  else delete index[directory]
  return dropped
}

// Distinct root sessions with a pending question, across all projects. This is
// the Dock badge's question contribution: one root session waiting on the user
// counts once, regardless of how many child agents under it are asking.
// Unresolved entries fall back to their asking session so they still count.
export function pendingRootSessionIDs(index: PendingQuestionIndex): Set<string> {
  const roots = new Set<string>()
  for (const bySession of Object.values(index)) {
    for (const list of Object.values(bySession)) {
      for (const question of list ?? []) roots.add(question.rootSessionID ?? question.sessionID)
    }
  }
  return roots
}

// The asking sessions in a directory that still hold a pending question — fed
// to session-trim so a child agent waiting on the user is never trimmed out of
// the session list (which would drop its parts and collapse the dock).
export function pendingSessionIDsForDirectory(index: PendingQuestionIndex, directory: string): Set<string> {
  return new Set(Object.keys(index[directory] ?? {}))
}
