import { createMemo } from "solid-js"
import { produce } from "solid-js/store"
import { Binary } from "@opencode-ai/util/binary"
import { showToast } from "@opencode-ai/ui/toast"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useGlobalSync } from "@/context/global-sync"
import type { usePlatform } from "@/context/platform"
import type { useServer } from "@/context/server"
import { dropSessionCaches } from "@/context/global-sync/session-cache"
import { errorMessage } from "./helpers"

export type SessionDeleteTarget = Pick<Session, "id" | "directory">

export type PawworkSessionCommandsInput = {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "child">
  platform: Pick<ReturnType<typeof usePlatform>, "exportSession">
  server: Pick<ReturnType<typeof useServer>, "current">
  language: { t: (key: string, params?: Record<string, string | number | boolean>) => string }
  navigate: (href: string) => void
  params: { id?: string; dir?: string }
}

export function createPawworkSessionCommands(input: PawworkSessionCommandsInput) {
  async function renamePawworkSession(session: Session, next: string) {
    const title = next.trim()
    if (!title || title === (session.title ?? "")) return

    try {
      await input.globalSDK.client.session.update({
        directory: session.directory,
        sessionID: session.id,
        title,
      })

      const [, setStore] = input.globalSync.child(session.directory)
      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, session.id, (item) => item.id)
          if (match.found) draft.session[match.index].title = title
        }),
      )
    } catch (error) {
      showToast({
        title: input.language.t("common.requestFailed"),
        description: errorMessage(error, input.language.t("common.requestFailed")),
      })
    }
  }

  // Export hits the embedded sidecar via main-process IPC. When the user has
  // switched the active server to a remote target, the sidecar holds different
  // data than the UI; hide the action rather than ship a misleading export.
  const exportSessionAvailable = createMemo(
    () => !!input.platform.exportSession && input.server.current?.type === "sidecar",
  )

  async function exportSession(session: Session) {
    if (!input.platform.exportSession) return
    const [store] = input.globalSync.child(session.directory)
    const sessionInfo = store.session?.find((s) => s.id === session.id)
    const slugSource = sessionInfo?.slug ?? session.id
    const sanitized = slugSource.replace(/[\\/:*?"<>|]/g, "-").slice(0, 32)
    const slug = /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : session.id.slice(-8)
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "")
    const defaultName = `pawwork-session-${slug}-${stamp}.json`

    let result: { ok: true; path: string } | { ok: false; error: string }
    try {
      result = await input.platform.exportSession(
        session.id,
        session.directory,
        defaultName,
        input.language.t("session.export.action.export"),
      )
    } catch (err) {
      showToast({
        title: input.language.t("session.export.error.failed"),
        description: errorMessage(err, input.language.t("common.requestFailed")),
        variant: "error",
      })
      return
    }
    if (!result.ok) {
      if (result.error === "cancelled") return
      showToast({
        title: input.language.t("session.export.error.failed"),
        description: result.error,
        variant: "error",
      })
      return
    }
    showToast({
      title: input.language.t("session.export.success"),
      description: result.path,
    })
  }

  async function deleteSession(session: SessionDeleteTarget) {
    const [store, setStore] = input.globalSync.child(session.directory)
    const sessions = (store.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await input.globalSDK.client.session
      .delete({ directory: session.directory, sessionID: session.id })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: input.language.t("session.delete.failed.title"),
          description: errorMessage(err, input.language.t("common.requestFailed")),
          variant: "error",
        })
        return undefined
      })

    if (!result) return

    setStore(
      produce((draft) => {
        const removed = new Set<string>([session.id])
        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }
        const stack = [session.id]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue
          const children = byParent.get(parentID)
          if (!children) continue
          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }
        dropSessionCaches(draft, [...removed])
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    if (session.id === input.params.id) {
      input.navigate(nextSession ? `/${input.params.dir}/session/${nextSession.id}` : `/${input.params.dir}/session`)
    }
  }

  return { exportSessionAvailable, renamePawworkSession, exportSession, deleteSession }
}
