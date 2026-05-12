import { createEffect, type Accessor } from "solid-js"
import type { Message as MessageType, Part } from "@opencode-ai/sdk/v2"
import type { UiI18n } from "@opencode-ai/ui/context/i18n"
import { showToast } from "@opencode-ai/ui/toast"
import { webSearchRecoveryToast } from "@/pages/session/websearch-toasts"

/**
 * Slice 11b.1: websearch toast surfacing watcher extracted from
 * `message-timeline.tsx` per design doc §3b.
 *
 * Walks each session message's parts looking for websearch tool parts
 * that just transitioned out of pending. When one fails with a
 * recoverable status (quota / invalid key) it surfaces a toast with an
 * action that opens the settings surface.
 *
 * Per-session cursors + pending sets are kept inside the watcher so the
 * timeline never re-renders for cursor moves; only the toast call is a
 * Solid effect output.
 */

function isWebSearchToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool" && part.tool === "websearch"
}

function isPendingWebSearchToolPart(part: Part) {
  return isWebSearchToolPart(part) && (part.state.status === "pending" || part.state.status === "running")
}

export type WebSearchToastWatcherInput = {
  sessionID: Accessor<string | undefined>
  sessionMessages: Accessor<MessageType[]>
  partsByMessageID: (messageID: string) => Part[] | undefined
  language: UiI18n
  openSettings: () => void
}

export function createWebSearchToastWatcher(input: WebSearchToastWatcherInput) {
  const surfaced = new Set<string>()
  const partCursor = new Map<string, number>()
  const pendingParts = new Map<string, Set<string>>()
  let lastSession: string | undefined

  createEffect(() => {
    const id = input.sessionID()
    if (id !== lastSession) {
      lastSession = id
      surfaced.clear()
      partCursor.clear()
      pendingParts.clear()
    }
    for (const message of input.sessionMessages()) {
      const parts = input.partsByMessageID(message.id) ?? []
      const start = partCursor.get(message.id) ?? 0
      const pending = pendingParts.get(message.id) ?? new Set<string>()
      const candidates = [
        ...parts.slice(start),
        ...parts.slice(0, start).filter((part) => pending.has(part.id)),
      ]
      for (const part of candidates) {
        if (isPendingWebSearchToolPart(part)) pending.add(part.id)
        else pending.delete(part.id)
        const toast = webSearchRecoveryToast(part, { surfaced })
        if (!toast) continue
        showToast({
          title: input.language.t(toast.titleKey),
          description: input.language.t(toast.descriptionKey),
          variant: "error",
          actions: [
            {
              label: input.language.t(toast.actionKey),
              onClick: input.openSettings,
            },
          ],
        })
      }
      partCursor.set(message.id, parts.length)
      if (pending.size > 0) pendingParts.set(message.id, pending)
      else pendingParts.delete(message.id)
    }
  })
}
