import { createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { sendFollowupDraft } from "@/components/prompt-input/submit"
import type { useGlobalSync } from "@/context/global-sync"
import type { useSDK } from "@/context/sdk"
import type { useSettings } from "@/context/settings"
import type { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"

export type FollowupItem = FollowupDraft & { id: string }
export type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
export const emptyFollowups: FollowupItem[] = []

export function followupPreviewText(input: {
  item: FollowupDraft
  attachmentLabel: string
}) {
  const text = input.item.prompt
    .map((part) => {
      if (part.type === "image") return `[image:${part.filename}]`
      if (part.type === "file") return `[file:${part.path}]`
      if (part.type === "agent") return `@${part.name}`
      return part.content
    })
    .join("")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => !!line)

  return text || `[${input.attachmentLabel}]`
}

export function shouldAutoSendFollowup(input: {
  hasSession: boolean
  hasItem: boolean
  busy: boolean
  failed: boolean
  paused: boolean
  childSession: boolean
  blocked: boolean
  followupBusy: boolean
}) {
  return (
    input.hasSession &&
    input.hasItem &&
    !input.busy &&
    !input.failed &&
    !input.paused &&
    !input.childSession &&
    !input.blocked &&
    !input.followupBusy
  )
}

export function createSessionFollowups(input: {
  directory: string
  client: ReturnType<typeof useSDK>["client"]
  sessionID: () => string | undefined
  isChildSession: () => boolean
  busy: () => boolean
  blocked: () => boolean
  settings: ReturnType<typeof useSettings>
  sync: ReturnType<typeof useSync>
  globalSync: ReturnType<typeof useGlobalSync>
  fail: (err: unknown) => void
  resumeScroll: () => void
  attachmentLabel: () => string
}) {
  const [followup, setFollowup] = persisted(
    Persist.workspace(input.directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  const queuedFollowups = createMemo(() => {
    const id = input.sessionID()
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = input.sessionID()
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (params: { sessionID: string; id: string; manual?: boolean }) => {
      const item = (followup.items[params.sessionID] ?? []).find((entry) => entry.id === params.id)
      if (!item) return

      if (params.manual) setFollowup("paused", params.sessionID, undefined)
      setFollowup("failed", params.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: input.client,
        sync: input.sync,
        globalSync: input.globalSync,
        draft: item,
        optimisticBusy: item.sessionDirectory === input.directory,
      }).catch((err) => {
        setFollowup("failed", params.sessionID, params.id)
        input.fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", params.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== params.id))
      if (params.manual) input.resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = input.sessionID()
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = input.sessionID()
    if (!id) return false
    return input.settings.general.followup() === "queue" && input.busy() && !input.blocked() && !input.isChildSession()
  })

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() =>
    queuedFollowups().map((item) => ({
      id: item.id,
      text: followupPreviewText({ item, attachmentLabel: input.attachmentLabel() }),
    })),
  )

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (input.sync.session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = input.sessionID()
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = input.sessionID()
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  createEffect(() => {
    const sessionID = input.sessionID()
    const item = queuedFollowups()[0]

    if (
      !shouldAutoSendFollowup({
        hasSession: !!sessionID,
        hasItem: !!item,
        busy: input.busy(),
        failed: !!(sessionID && item && followup.failed[sessionID] === item.id),
        paused: !!(sessionID && followup.paused[sessionID]),
        childSession: input.isChildSession(),
        blocked: input.blocked(),
        followupBusy: !!(sessionID && followupBusy(sessionID)),
      })
    ) {
      return
    }

    void sendFollowup(sessionID!, item!.id)
  })

  return {
    queueEnabled,
    followupDock,
    queuedFollowups,
    editingFollowup,
    sendingFollowup,
    queueFollowup,
    sendFollowup,
    editFollowup,
    clearFollowupEdit,
    pause(sessionID: string) {
      setFollowup("paused", sessionID, true)
    },
  }
}
