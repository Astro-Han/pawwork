import type { useLanguage } from "@/context/language"
import type { useSync } from "@/context/sync"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { pending } from "./submit-abort"

type WaitForWorktreeInput = {
  sessionDirectory: string
  projectDirectory: string
  sessionID: string
  sync: ReturnType<typeof useSync>
  language: ReturnType<typeof useLanguage>
  removeOptimisticMessage: () => void
  restoreInput: () => void
}

export function createWaitForWorktree(input: WaitForWorktreeInput) {
  const { sessionDirectory, projectDirectory, sessionID, sync, language, removeOptimisticMessage, restoreInput } = input

  return async () => {
    const worktree = WorktreeState.get(sessionDirectory)
    if (!worktree || worktree.status !== "pending") return true

    if (sessionDirectory === projectDirectory) {
      sync.set("session_status", sessionID, { type: "busy" })
    }

    const controller = new AbortController()
    const cleanup = () => {
      if (sessionDirectory === projectDirectory) {
        sync.set("session_status", sessionID, { type: "idle" })
      }
      removeOptimisticMessage()
      // restoreInput handles route-case comment items internally; owner-backed
      // cases re-push context from the snapshot via replaceAll.
      restoreInput()
    }

    pending.set(sessionID, { abort: controller, cleanup })

    const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
      if (controller.signal.aborted) {
        resolve({ status: "failed", message: "aborted" })
        return
      }
      controller.signal.addEventListener(
        "abort",
        () => {
          resolve({ status: "failed", message: "aborted" })
        },
        { once: true },
      )
    })

    const timeoutMs = 5 * 60 * 1000
    const timer = { id: undefined as number | undefined }
    const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
      timer.id = window.setTimeout(() => {
        resolve({
          status: "failed",
          message: language.t("workspace.error.stillPreparing"),
        })
      }, timeoutMs)
    })

    const result = await Promise.race([WorktreeState.wait(sessionDirectory), abortWait, timeout]).finally(() => {
      if (timer.id === undefined) return
      clearTimeout(timer.id)
    })
    pending.delete(sessionID)
    if (controller.signal.aborted) return false
    if (result.status === "failed") throw new Error(result.message)
    return true
  }
}
