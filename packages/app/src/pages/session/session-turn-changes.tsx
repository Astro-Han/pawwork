import { createEffect, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import type { Message as MessageType } from "@opencode-ai/sdk/v2"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import {
  turnFetchSignature,
  turnFetchTargets,
  type TurnFetchAssistantLite,
  type TurnFetchInput,
} from "@/pages/session/turn-change-fetch"

type Translate = (key: string, params?: Record<string, unknown>) => string

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

export function buildTurnFetchInput(sessionID: string | undefined, messages: MessageType[]): TurnFetchInput | null {
  if (!sessionID) return null
  const assistants: TurnFetchAssistantLite[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    assistants.push({
      id: message.id,
      parentID: message.parentID,
      completed: message.time.completed,
    })
  }
  return { sessionID, assistants }
}

export function blockedTurnChangeDescription(body: any, t: Translate) {
  const base =
    body?.reason === "conflict"
      ? t("session.turnChange.blocked.conflict")
      : body?.reason === "unsupported_size"
        ? t("session.turnChange.blocked.unsupportedSize")
        : body?.reason === "permission_denied"
          ? t("session.turnChange.blocked.permissionDenied")
          : body?.reason === "rollback_failed"
            ? t("session.turnChange.blocked.rollbackFailed")
            : t("session.turnChange.blocked.generic")
  const files = Array.isArray(body?.files)
    ? body.files.filter((file: any) => typeof file?.path === "string").map((file: any) => file.path as string)
    : []
  if (!files.length) return base
  const visible = files.slice(0, 3).join(", ")
  const rest = files.length > 3 ? `, ${t("session.turnChange.blocked.more", { count: files.length - 3 })}` : ""
  return `${base} ${t("session.turnChange.blocked.files", { files: `${visible}${rest}` })}`
}

export function createSessionTurnChanges(input: {
  sessionID: Accessor<string | undefined>
  sessionMessages: Accessor<MessageType[]>
}) {
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const translate: Translate = (key, params) => language.t(key as any, params as any)

  const [turnChanges, setTurnChanges] = createStore<Record<string, TurnChangeDisplay | null>>({})
  const fetchedTurnChanges = new Set<string>()
  const turnChangeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const cancelTurnChangeRetries = () => {
    for (const timer of turnChangeRetryTimers.values()) clearTimeout(timer)
    turnChangeRetryTimers.clear()
  }

  const authHeaders = () => {
    const current = server.current
    if (!current?.http.password) return {} as Record<string, string>
    return {
      Authorization: `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`,
    }
  }

  const showActionError = (action: "undo" | "redo") => {
    showToast({
      title:
        action === "undo" ? language.t("session.turnChange.undoBlocked") : language.t("session.turnChange.redoBlocked"),
      description: language.t("session.turnChange.blocked.generic"),
      variant: "error",
    })
  }

  const fetchTurnChange = async (
    userMessageID: string,
    action?: "undo" | "redo",
    options?: { force?: boolean },
  ): Promise<TurnChangeDisplay | undefined> => {
    const current = server.current
    const id = input.sessionID()
    if (!current || !id) return
    const url = `${current.http.url}/session/${id}/turn/${userMessageID}/changes${action ? `/${action}` : ""}`
    let res: Response
    try {
      res = await fetch(url, {
        method: action ? "POST" : "GET",
        headers: {
          ...authHeaders(),
          ...(action ? { "Content-Type": "application/json" } : {}),
        },
        ...(action ? { body: JSON.stringify({ force: !!options?.force }) } : {}),
      })
    } catch {
      if (action) showActionError(action)
      return turnChanges[userMessageID] ?? undefined
    }
    if (!res.ok) {
      if (action) showActionError(action)
      return turnChanges[userMessageID] ?? undefined
    }
    let body: any
    try {
      body = await res.json()
    } catch {
      if (action) showActionError(action)
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
    if (body?.status === "blocked" && body.reason === "conflict" && !options?.force) {
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
        dialog.show(
          () => (
            <Dialog
              title={language.t("ui.sessionTurn.turnChanges.confirmTitle")}
              description={language.t("ui.sessionTurn.turnChanges.confirmDescription")}
              size="normal"
              fit
            >
              <div class="flex flex-col gap-4 px-5 pb-5 pt-2">
                <Show when={conflictPaths.length > 0}>
                  <div class="flex flex-col rounded-md border border-border-base bg-surface-base max-h-44 overflow-auto">
                    <For each={conflictPaths.slice(0, 6)}>
                      {(item) => (
                        <div
                          class="px-3 py-1.5 text-body text-fg-strong font-mono truncate"
                          title={item}
                        >
                          {item}
                        </div>
                      )}
                    </For>
                    <Show when={conflictPaths.length > 6}>
                      <div class="px-3 py-1.5 text-caption text-fg-weak border-t border-border-base">
                        {language.t("ui.sessionTurn.turnChanges.confirmListMore", {
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
                      dialog.close()
                      finish(undefined)
                    }}
                  >
                    {language.t("ui.sessionTurn.turnChanges.confirmCancel")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      dialog.close()
                      const next = await fetchTurnChange(userMessageID, action, { force: true })
                      finish(next)
                    }}
                  >
                    {language.t("ui.sessionTurn.turnChanges.confirmApply")}
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
        action === "undo" ? language.t("session.turnChange.undoBlocked") : language.t("session.turnChange.redoBlocked"),
      description: blockedTurnChangeDescription(body, translate),
      variant: "error",
    })
    return turnChanges[userMessageID] ?? undefined
  }

  const turnFetchInput = () => buildTurnFetchInput(input.sessionID(), input.sessionMessages())

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
  createEffect(
    on(
      () => {
        const next = turnFetchInput()
        return next ? turnFetchSignature(next) : ""
      },
      () => {
        const next = turnFetchInput()
        if (!next) return
        for (const target of turnFetchTargets(next)) {
          if (fetchedTurnChanges.has(target.key)) continue
          fetchedTurnChanges.add(target.key)
          void fetchTurnChange(target.userMessageID)
            .then((display) => {
              if (display) return
              if (turnChangeRetryTimers.has(target.key)) return
              const timer = setTimeout(() => {
                turnChangeRetryTimers.delete(target.key)
                void fetchTurnChange(target.userMessageID).catch(() => undefined)
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

  return {
    turnChanges,
    actions: {
      undo: (userMessageID: string, options?: { force?: boolean }) => fetchTurnChange(userMessageID, "undo", options),
      redo: (userMessageID: string, options?: { force?: boolean }) => fetchTurnChange(userMessageID, "redo", options),
    },
  }
}
