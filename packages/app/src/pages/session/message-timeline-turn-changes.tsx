import { createEffect, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import type { Message as MessageType } from "@opencode-ai/sdk/v2"
import type { UiI18n } from "@opencode-ai/ui/context/i18n"
import {
  turnFetchSignature,
  turnFetchTargets,
  type TurnFetchAssistantLite,
  type TurnFetchInput,
} from "@/pages/session/turn-change-fetch"

/**
 * Slice 11b.1: turn-change fetcher + auto-prefetch effect + conflict
 * dialog extracted from `message-timeline.tsx` per design doc §3b.
 *
 * The timeline keeps a store of `TurnChangeDisplay` records keyed by
 * user message id. `createTurnChangeFetcher` owns:
 *
 *   - the store itself (read via the returned `turnChanges`);
 *   - imperative `fetch(messageID, "undo" | "redo", { force })` for the
 *     turn header actions, including the conflict confirmation dialog;
 *   - the auto-prefetch effect that walks `turnFetchTargets()` for the
 *     current session whenever the assistant signature changes, with a
 *     500ms retry timer for transient empty responses;
 *   - lifecycle cleanup (retry timers + session-change clears).
 *
 * Inputs:
 *   - `sessionID` / `sessionMessages` — accessors over the timeline's
 *     current session and its messages.
 *   - `language` — the i18n surface for toast titles / dialog copy.
 *   - `dialog` — the Kobalte-backed dialog host.
 *   - `authHeaders` — basic-auth resolver for embedded sidecar servers.
 *   - `httpUrl` — accessor over the active server's HTTP URL.
 */

export type TurnChangeDisplay = {
  sessionID: string
  turnID: string
  messageID: string
  undoAvailable: boolean
  redoAvailable: boolean
  truncated?: boolean
  omittedCount?: number
  skippedCount?: number
  files: Array<{
    path: string
    openPath?: string
    status: "added" | "modified" | "deleted"
    additions?: number
    deletions?: number
    patch?: string
    sensitive?: boolean
    binary?: boolean
    large?: boolean
    restoreAvailable?: boolean
    expandable: boolean
  }>
}

export type TurnChangeFetcherInput = {
  sessionID: Accessor<string | undefined>
  sessionMessages: Accessor<MessageType[]>
  language: UiI18n
  dialog: { show: (render: () => any, onClose?: () => void) => void; close: () => void }
  authHeaders: () => Record<string, string>
  httpUrl: () => string | undefined
}

export type TurnChangeFetcher = {
  turnChanges: Record<string, TurnChangeDisplay | null>
  fetch: (
    userMessageID: string,
    action?: "undo" | "redo",
    options?: { force?: boolean },
  ) => Promise<TurnChangeDisplay | undefined>
}

export function createTurnChangeFetcher(input: TurnChangeFetcherInput): TurnChangeFetcher {
  const [turnChanges, setTurnChanges] = createStore<Record<string, TurnChangeDisplay | null>>({})
  const fetchedTurnChanges = new Set<string>()
  const turnChangeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const cancelTurnChangeRetries = () => {
    for (const timer of turnChangeRetryTimers.values()) clearTimeout(timer)
    turnChangeRetryTimers.clear()
  }
  onCleanup(cancelTurnChangeRetries)

  createEffect(
    on(
      input.sessionID,
      () => {
        cancelTurnChangeRetries()
        fetchedTurnChanges.clear()
      },
      { defer: true },
    ),
  )

  const blockedDescription = (body: any) => {
    const base =
      body?.reason === "conflict"
        ? input.language.t("session.turnChange.blocked.conflict")
        : body?.reason === "unsupported_size"
          ? input.language.t("session.turnChange.blocked.unsupportedSize")
          : body?.reason === "permission_denied"
            ? input.language.t("session.turnChange.blocked.permissionDenied")
            : body?.reason === "rollback_failed"
              ? input.language.t("session.turnChange.blocked.rollbackFailed")
              : input.language.t("session.turnChange.blocked.generic")
    const files = Array.isArray(body?.files)
      ? body.files.filter((file: any) => typeof file?.path === "string").map((file: any) => file.path as string)
      : []
    if (!files.length) return base
    const visible = files.slice(0, 3).join(", ")
    const rest = files.length > 3
      ? input.language.t("session.turnChange.blocked.more", { count: files.length - 3 })
      : ""
    return `${base} ${input.language.t("session.turnChange.blocked.files", { files: `${visible}${rest}` })}`
  }

  const turnChangeFetch = async (
    userMessageID: string,
    action?: "undo" | "redo",
    options?: { force?: boolean },
  ): Promise<TurnChangeDisplay | undefined> => {
    const httpBase = input.httpUrl()
    const id = input.sessionID()
    if (!httpBase || !id) return
    const url = `${httpBase}/session/${id}/turn/${userMessageID}/changes${action ? `/${action}` : ""}`
    let res: Response
    try {
      res = await fetch(url, {
        method: action ? "POST" : "GET",
        headers: {
          ...input.authHeaders(),
          ...(action ? { "Content-Type": "application/json" } : {}),
        },
        ...(action ? { body: JSON.stringify({ force: !!options?.force }) } : {}),
      })
    } catch (err) {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? input.language.t("session.turnChange.undoBlocked")
              : input.language.t("session.turnChange.redoBlocked"),
          description: input.language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    if (!res.ok) {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? input.language.t("session.turnChange.undoBlocked")
              : input.language.t("session.turnChange.redoBlocked"),
          description: input.language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    let body: any
    try {
      body = await res.json()
    } catch {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? input.language.t("session.turnChange.undoBlocked")
              : input.language.t("session.turnChange.redoBlocked"),
          description: input.language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    if (!action) {
      setTurnChanges(userMessageID, body ?? null)
      return body ?? undefined
    }
    if (body?.status === "applied") {
      const rawDisplay: TurnChangeDisplay | null = body.display ?? null
      let display: TurnChangeDisplay | null = rawDisplay
      if (rawDisplay && Array.isArray(body.skipped) && body.skipped.length) {
        const skippedCount = body.skipped.reduce(
          (sum: number, item: any) => sum + (Array.isArray(item?.files) ? item.files.length : 0),
          0,
        )
        if (skippedCount > 0) display = { ...rawDisplay, skippedCount }
      }
      setTurnChanges(userMessageID, display)
      return display ?? undefined
    }
    if (action && body?.status === "blocked" && body.reason === "conflict" && !options?.force) {
      const conflictPaths = Array.isArray(body.files)
        ? (body.files as Array<{ path?: unknown }>)
            .map((file) => (typeof file?.path === "string" ? file.path : ""))
            .filter((path) => path.length > 0)
        : []
      return await new Promise<TurnChangeDisplay | undefined>((resolve) => {
        let settled = false
        const finish = (value: TurnChangeDisplay | undefined) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        input.dialog.show(
          () => (
            <Dialog
              title={input.language.t("ui.sessionTurn.turnChanges.confirmTitle")}
              description={input.language.t("ui.sessionTurn.turnChanges.confirmDescription")}
              size="normal"
              fit
            >
              <div class="flex flex-col gap-4 px-5 pb-5 pt-2">
                <Show when={conflictPaths.length > 0}>
                  <div class="flex flex-col rounded-md border border-border-base bg-surface-base max-h-44 overflow-auto">
                    <For each={conflictPaths.slice(0, 6)}>
                      {(item) => (
                        <div
                          class="px-3 py-1.5 text-13-regular text-fg-strong font-mono truncate"
                          title={item}
                        >
                          {item}
                        </div>
                      )}
                    </For>
                    <Show when={conflictPaths.length > 6}>
                      <div class="px-3 py-1.5 text-12-regular text-fg-weak border-t border-border-base">
                        {input.language.t("ui.sessionTurn.turnChanges.confirmListMore", {
                          count: conflictPaths.length - 6,
                        })}
                      </div>
                    </Show>
                  </div>
                </Show>
                <div class="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      input.dialog.close()
                      finish(undefined)
                    }}
                  >
                    {input.language.t("ui.sessionTurn.turnChanges.confirmCancel")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      input.dialog.close()
                      const next = await turnChangeFetch(userMessageID, action, { force: true })
                      finish(next)
                    }}
                  >
                    {input.language.t("ui.sessionTurn.turnChanges.confirmApply")}
                  </Button>
                </div>
              </div>
            </Dialog>
          ),
          () => finish(undefined),
        )
      })
    }
    showToast({
      title:
        action === "undo"
          ? input.language.t("session.turnChange.undoBlocked")
          : input.language.t("session.turnChange.redoBlocked"),
      description: blockedDescription(body),
      variant: "error",
    })
    return turnChanges[userMessageID] ?? undefined
  }

  const turnFetchInputBuilder = (): TurnFetchInput | null => {
    const id = input.sessionID()
    if (!id) return null
    const assistants: TurnFetchAssistantLite[] = []
    for (const message of input.sessionMessages()) {
      if (message.role !== "assistant") continue
      assistants.push({
        id: message.id,
        parentID: message.parentID,
        completed: message.time.completed,
      })
    }
    return { sessionID: id, assistants }
  }

  createEffect(
    on(
      () => {
        const built = turnFetchInputBuilder()
        return built ? turnFetchSignature(built) : ""
      },
      () => {
        const built = turnFetchInputBuilder()
        if (!built) return
        for (const target of turnFetchTargets(built)) {
          if (fetchedTurnChanges.has(target.key)) continue
          fetchedTurnChanges.add(target.key)
          void turnChangeFetch(target.userMessageID)
            .then((display) => {
              if (display) return
              if (turnChangeRetryTimers.has(target.key)) return
              const timer = setTimeout(() => {
                turnChangeRetryTimers.delete(target.key)
                void turnChangeFetch(target.userMessageID).catch(() => undefined)
              }, 500)
              turnChangeRetryTimers.set(target.key, timer)
            })
            .catch(() => {
              fetchedTurnChanges.delete(target.key)
              setTurnChanges(target.userMessageID, null)
            })
        }
      },
    ),
  )

  return { turnChanges, fetch: turnChangeFetch }
}
