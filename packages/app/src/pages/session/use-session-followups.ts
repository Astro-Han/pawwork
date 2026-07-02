import { createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useMutation } from "@tanstack/solid-query"
import { followupCommandText, type FollowupDraft } from "@/components/prompt-input/followup-draft"
import { sendFollowupDraft } from "@/components/prompt-input/send-followup-draft"
import type { useGlobalSync } from "@/context/global-sync"
import type { useSDK } from "@/context/sdk"
import type { useSettings } from "@/context/settings"
import type { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { canSendFollowupDraft } from "./session-action-readiness"
import { sameSessionScope, sessionScopeKey, type SessionScope } from "./session-scope"

export type FollowupItem = FollowupDraft & { id: string; sourceScope: SessionScope }
export type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
export const emptyFollowups: FollowupItem[] = []

export function followupPreviewText(input: {
  item: FollowupDraft
  attachmentLabel: string
}) {
  const text = input.item.prompt
    .map((part) => {
      if (part.type === "image") return `[image:${part.filename}]`
      if (part.type === "attachment") return `[file:${part.path}]`
      if (part.type === "file") return `[file:${part.path}]`
      if (part.type === "agent") return `@${part.name}`
      if (part.type === "skill") return `/${part.name}`
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
  actionReady: boolean
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
    input.actionReady &&
    !input.busy &&
    !input.failed &&
    !input.paused &&
    !input.childSession &&
    !input.blocked &&
    !input.followupBusy
  )
}

export function followupDraftForDirectory(item: FollowupItem, directory: string): FollowupItem {
  if (item.sessionDirectory === directory) return item
  return { ...item, sessionDirectory: directory }
}

export function followupStoreKey(scope: SessionScope) {
  return sessionScopeKey(scope)
}

export function scopedFollowupDraft<T extends FollowupDraft & { id: string }>(
  draft: T,
  scope: SessionScope,
): T & { sourceScope: SessionScope } {
  return { ...draft, sourceScope: { ...scope } }
}

export function followupDraftMatchesScope(item: { sourceScope?: SessionScope }, scope: SessionScope | undefined) {
  if (!scope) return false
  if (!item.sourceScope) return false
  return sameSessionScope(item.sourceScope, scope)
}

export function canSendFollowupItem(input: { item: FollowupDraft; actionReady: boolean; commandsReady: boolean }) {
  return canSendFollowupDraft({
    draft: { text: followupCommandText(input.item) },
    submitReady: input.actionReady,
    commandsReady: input.commandsReady,
  })
}

export function createSessionFollowups(input: {
  directory: () => string
  client: () => ReturnType<typeof useSDK>["client"]
  sessionID: () => string | undefined
  sessionScope: () => SessionScope | undefined
  actionReady: () => boolean
  isChildSession: () => boolean
  busy: () => boolean
  blocked: () => boolean
  settings: ReturnType<typeof useSettings>
  sync: ReturnType<typeof useSync>
  globalSync: ReturnType<typeof useGlobalSync>
  fail: (err: unknown) => void
  resumeScroll: () => void
  attachmentLabel: () => string
  sendFollowup?: typeof sendFollowupDraft
}) {
  const [followup, setFollowup] = persisted(
    Persist.global("session-followup.v2", ["followup.v2"]),
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

  const activeFollowupKey = createMemo(() => {
    const scope = input.sessionScope()
    return scope ? followupStoreKey(scope) : undefined
  })

  const queuedFollowups = createMemo(() => {
    const key = activeFollowupKey()
    if (!key) return emptyFollowups
    return followup.items[key] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const key = activeFollowupKey()
    if (!key) return
    return followup.edit[key]
  })

  type SendFollowupVariables = {
    key: string
    sessionID: string
    id: string
    manual?: boolean
  }

  const [pendingFollowups, setPendingFollowups] = createSignal<Record<string, string | undefined>>({})
  const sendFollowupDraftForInput = input.sendFollowup ?? sendFollowupDraft
  const markFollowupPending = (key: string, id: string) => {
    setPendingFollowups((current) => ({ ...current, [key]: id }))
  }
  const clearFollowupPending = (key: string, id: string) => {
    setPendingFollowups((current) => {
      if (current[key] !== id) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  const followupMutation = useMutation(() => ({
    mutationFn: async (params: SendFollowupVariables) => {
      markFollowupPending(params.key, params.id)
      try {
        const item = (followup.items[params.key] ?? []).find((entry) => entry.id === params.id)
        if (!item || item.sessionID !== params.sessionID || !followupDraftMatchesScope(item, input.sessionScope())) return

        if (params.manual) setFollowup("paused", params.key, undefined)
        setFollowup("failed", params.key, undefined)

        const directory = input.directory()
        const draft = followupDraftForDirectory(item, directory)
        const ok = await sendFollowupDraftForInput({
          client: input.client(),
          sync: input.sync,
          globalSync: input.globalSync,
          draft,
          optimisticBusy: draft.sessionDirectory === directory,
        }).catch((err) => {
          setFollowup("failed", params.key, params.id)
          input.fail(err)
          return false
        })
        if (!ok) return

        setFollowup("items", params.key, (items) => (items ?? []).filter((entry) => entry.id !== params.id))
        if (params.manual) input.resumeScroll()
      } finally {
        clearFollowupPending(params.key, params.id)
      }
    },
  }))

  const followupBusy = (key: string | undefined) => !!key && pendingFollowups()[key] !== undefined

  const sendingFollowup = createMemo(() => {
    const key = activeFollowupKey()
    if (!key || !followupBusy(key)) return
    return pendingFollowups()[key]
  })

  const queueEnabled = createMemo(() => {
    const id = input.sessionID()
    const key = activeFollowupKey()
    if (!id || !key) return false
    return (
      input.actionReady() &&
      input.settings.general.followup() === "queue" &&
      input.busy() &&
      !input.blocked() &&
      !input.isChildSession()
    )
  })

  const queueFollowup = (draft: FollowupDraft) => {
    const scope = input.sessionScope()
    if (!scope) return
    const key = followupStoreKey(scope)
    const item = scopedFollowupDraft({ id: Identifier.ascending("message"), ...draft }, scope)
    setFollowup("items", key, (items) => [...(items ?? []), item])
    setFollowup("failed", key, undefined)
    setFollowup("paused", key, undefined)
  }

  const followupDock = createMemo(() =>
    queuedFollowups().map((item) => ({
      id: item.id,
      text: followupPreviewText({ item, attachmentLabel: input.attachmentLabel() }),
    })),
  )

  const sendFollowup = (id: string, opts?: { manual?: boolean }) => {
    const key = activeFollowupKey()
    const sessionID = input.sessionID()
    if (!key || !sessionID) return Promise.resolve()
    if (input.sync.session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[key] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (!followupDraftMatchesScope(item, input.sessionScope())) return Promise.resolve()
    if (
      !canSendFollowupItem({
        item,
        actionReady: input.actionReady(),
        commandsReady: input.sync.data.command_ready,
      })
    ) {
      return Promise.resolve()
    }
    if (followupBusy(key)) return Promise.resolve()

    return followupMutation.mutateAsync({ key, sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const key = activeFollowupKey()
    if (!key) return
    if (followupBusy(key)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", key, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", key, (value) => (value === id ? undefined : value))
    setFollowup("edit", key, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const key = activeFollowupKey()
    if (!key) return
    setFollowup("edit", key, undefined)
  }

  createEffect(() => {
    const sessionID = input.sessionID()
    const key = activeFollowupKey()
    const item = queuedFollowups()[0]

    if (
      !shouldAutoSendFollowup({
        hasSession: !!sessionID,
        hasItem: !!item,
        actionReady: !!(
          item &&
          canSendFollowupItem({
            item,
            actionReady: input.actionReady(),
            commandsReady: input.sync.data.command_ready,
          })
        ),
        busy: input.busy(),
        failed: !!(key && item && followup.failed[key] === item.id),
        paused: !!(key && followup.paused[key]),
        childSession: input.isChildSession(),
        blocked: input.blocked(),
        followupBusy: followupBusy(key),
      })
    ) {
      return
    }

    void sendFollowup(item!.id)
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
    pause() {
      const key = activeFollowupKey()
      if (!key) return
      setFollowup("paused", key, true)
    },
  }
}
