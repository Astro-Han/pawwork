import type { Session, UserMessage } from "@opencode-ai/sdk/v2"
import { useMutation } from "@tanstack/solid-query"
import { batch, createMemo } from "solid-js"
import type { Prompt, usePrompt } from "@/context/prompt"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { readSessionMessages, readUserMessages } from "@/pages/session/session-messages"

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
  client: ReturnType<typeof useSDK>["client"]
  halt: (sessionID: string) => Promise<unknown>
  draft: (id: string) => Prompt
  fail: (err: unknown) => void
  merge: (next: Session) => void
  roll: (sessionID: string, next: Session["revert"]) => void
}) {
  const revertMutation = useMutation(() => ({
    mutationFn: async (request: { sessionID: string; messageID: string }) => {
      const prev = input.prompt.current().slice()
      const last = input.sync.session.get(request.sessionID)?.revert
      const value = input.draft(request.messageID)
      batch(() => {
        input.roll(request.sessionID, { messageID: request.messageID })
        input.prompt.set(value)
      })
      await input
        .halt(request.sessionID)
        .then(() => input.client.session.revert(request, { throwOnError: true }))
        .then((result) => {
          if (result.data) input.merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            input.roll(request.sessionID, last)
            input.prompt.set(prev)
          })
          input.fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (request: { sessionID: string; id: string }) => {
      const messages = readUserMessages(readSessionMessages(input.sync.data.message[request.sessionID]))
      const next = nextRestoreTarget(messages, request.id)
      const prev = input.prompt.current().slice()
      const last = input.sync.session.get(request.sessionID)?.revert

      batch(() => {
        input.roll(request.sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          input.prompt.set(input.draft(next.id))
        } else {
          input.prompt.reset()
        }
      })

      const task = !next
        ? input
            .halt(request.sessionID)
            .then(() => input.client.session.unrevert({ sessionID: request.sessionID }, { throwOnError: true }))
        : input.halt(request.sessionID).then(() =>
            input.client.session.revert(
              {
                sessionID: request.sessionID,
                messageID: next.id,
              },
              { throwOnError: true },
            ),
          )

      await task
        .then((result) => {
          if (result.data) input.merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            input.roll(request.sessionID, last)
            input.prompt.set(prev)
          })
          input.fail(err)
        })
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
      return revertMutation.mutateAsync(request)
    },
    restore(id: string) {
      const sessionID = input.sessionID()
      if (!sessionID || reverting()) return
      return restoreMutation.mutateAsync({ sessionID, id })
    },
  }
}
