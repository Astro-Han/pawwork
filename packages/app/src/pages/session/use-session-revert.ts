import type { Session, UserMessage } from "@opencode-ai/sdk/v2"
import { useMutation } from "@tanstack/solid-query"
import { batch, createMemo } from "solid-js"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { readSessionMessages, readUserMessages } from "@/pages/session/session-messages"
import { shouldApplyExecutionResult, type ExecutionScope } from "./execution-scope"

type SyncSetter = ReturnType<typeof useSync>["set"]
type SyncStore = ReturnType<typeof useSync>["data"]
type RevertSnapshot = {
  scope: ExecutionScope
  currentScope: () => ExecutionScope | undefined
  directory: string
  client: ReturnType<typeof useSDK>["client"]
  store: SyncStore
  setStore: SyncSetter
  prompt: Prompt
  promptScope: {
    dir: string
    id?: string
  }
  release: VoidFunction
}

const findSession = (store: SyncStore, sessionID: string) => store.session.find((item) => item.id === sessionID)

export function revertSnapshotIsCurrent(input: Pick<RevertSnapshot, "scope" | "currentScope">) {
  return shouldApplyExecutionResult({ requested: input.scope, current: input.currentScope() })
}

const applyIfCurrent = (snapshot: RevertSnapshot, run: () => void) => {
  if (!revertSnapshotIsCurrent(snapshot)) return
  run()
}

export function revertRequestPayload(input: { sessionID: string; messageID: string }) {
  return {
    sessionID: input.sessionID,
    messageID: input.messageID,
  }
}

export function rolledRevertItems(input: {
  revertMessageID: string | undefined
  messages: UserMessage[]
  lineText: (id: string) => string
}) {
  const id = input.revertMessageID
  if (!id) return []
  const start = input.messages.findIndex((item) => item.id === id)
  if (start < 0) return []
  return input.messages
    .slice(start)
    .map((item) => ({ id: item.id, text: input.lineText(item.id) }))
}

export function nextRestoreTarget(messages: UserMessage[], id: string) {
  const index = messages.findIndex((item) => item.id === id)
  return index >= 0 ? messages[index + 1] : undefined
}

export function createSessionRevert(input: {
  sessionID: () => string | undefined
  revertMessageID: () => string | undefined
  timelineUserMessages: () => UserMessage[]
  lineText: (id: string) => string
  prompt: ReturnType<typeof usePrompt>
  sync: ReturnType<typeof useSync>
  snapshot: () => RevertSnapshot
  actionReady: () => boolean
  halt: (snapshot: RevertSnapshot, sessionID: string) => Promise<unknown>
  draft: (source: Pick<RevertSnapshot, "directory" | "store">, id: string) => Prompt
  fail: (err: unknown) => void
  merge: (setStore: SyncSetter, next: Session) => void
  roll: (setStore: SyncSetter, sessionID: string, next: Session["revert"]) => void
}) {
  const revertMutation = useMutation(() => ({
    mutationFn: async (request: { sessionID: string; messageID: string; snapshot: RevertSnapshot }) => {
      const snapshot = request.snapshot
      try {
        const prev = snapshot.prompt
        const last = findSession(snapshot.store, request.sessionID)?.revert
        const value = input.draft(snapshot, request.messageID)
        batch(() => {
          input.roll(snapshot.setStore, request.sessionID, { messageID: request.messageID })
          input.prompt.set(value, undefined, snapshot.promptScope)
        })
        await input
          .halt(snapshot, request.sessionID)
          .then(() => snapshot.client.session.revert(revertRequestPayload(request), { throwOnError: true }))
          .then((result) => {
            if (result.data) applyIfCurrent(snapshot, () => input.merge(snapshot.setStore, result.data!))
          })
          .catch((err) => {
            applyIfCurrent(snapshot, () => {
              batch(() => {
                input.roll(snapshot.setStore, request.sessionID, last)
                input.prompt.set(prev, undefined, snapshot.promptScope)
              })
            })
            input.fail(err)
          })
      } finally {
        snapshot.release()
      }
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (request: { sessionID: string; id: string; snapshot: RevertSnapshot }) => {
      const snapshot = request.snapshot
      try {
        const messages = readUserMessages(readSessionMessages(snapshot.store.message[request.sessionID]))
        const next = nextRestoreTarget(messages, request.id)
        const prev = snapshot.prompt
        const last = findSession(snapshot.store, request.sessionID)?.revert

        batch(() => {
          input.roll(snapshot.setStore, request.sessionID, next ? { messageID: next.id } : undefined)
          if (next) {
            input.prompt.set(input.draft(snapshot, next.id), undefined, snapshot.promptScope)
          } else {
            input.prompt.reset(snapshot.promptScope)
          }
        })

        const task = !next
          ? input
              .halt(snapshot, request.sessionID)
              .then(() => snapshot.client.session.unrevert({ sessionID: request.sessionID }, { throwOnError: true }))
          : input.halt(snapshot, request.sessionID).then(() =>
              snapshot.client.session.revert(
                {
                  sessionID: request.sessionID,
                  messageID: next.id,
                },
                { throwOnError: true },
              ),
            )

        await task
          .then((result) => {
            if (result.data) applyIfCurrent(snapshot, () => input.merge(snapshot.setStore, result.data!))
          })
          .catch((err) => {
            applyIfCurrent(snapshot, () => {
              batch(() => {
                input.roll(snapshot.setStore, request.sessionID, last)
                input.prompt.set(prev, undefined, snapshot.promptScope)
              })
            })
            input.fail(err)
          })
      } finally {
        snapshot.release()
      }
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => {
    if (!restoreMutation.isPending) return
    const variables = restoreMutation.variables
    if (variables?.sessionID !== input.sessionID()) return
    return variables.id
  })
  const rolled = createMemo(() =>
    rolledRevertItems({
      revertMessageID: input.revertMessageID(),
      messages: input.timelineUserMessages(),
      lineText: input.lineText,
    }),
  )

  return {
    reverting,
    restoring,
    rolled,
    revert(request: { sessionID: string; messageID: string }) {
      if (reverting()) return
      if (!input.actionReady()) return
      return revertMutation.mutateAsync({ ...request, snapshot: input.snapshot() })
    },
    restore(id: string) {
      const sessionID = input.sessionID()
      if (!sessionID || reverting()) return
      if (!input.actionReady()) return
      return restoreMutation.mutateAsync({ sessionID, id, snapshot: input.snapshot() })
    },
  }
}
