import { createEffect, onCleanup, onMount } from "solid-js"
import type { Platform } from "@/context/platform"
import type { ToastOptions } from "@opencode-ai/ui/toast"

type UpdateCopyKey =
  | "toast.update.title"
  | "toast.update.description"
  | "toast.update.action.installRestart"
  | "toast.update.action.notYet"

type UpdateCopy = {
  t(key: UpdateCopyKey, params?: Record<string, string | number | boolean>): string
}

type ShowToast = (options: ToastOptions | string) => number

export function useUpdatePolling(input: {
  platform: Pick<Platform, "checkUpdate" | "update">
  settings: {
    ready: () => boolean
    updates: {
      startup: () => boolean
    }
  }
  copy: UpdateCopy
  effects: {
    showToast: ShowToast
  }
}) {
  onMount(() => {
    const checkUpdate = input.platform.checkUpdate
    const update = input.platform.update
    if (!checkUpdate || !update) return

    let toastId: number | undefined
    let interval: ReturnType<typeof setInterval> | undefined

    const pollUpdate = () =>
      checkUpdate().then(({ updateAvailable, version }) => {
        if (!updateAvailable) return
        if (toastId !== undefined) return
        toastId = input.effects.showToast({
          persistent: true,
          icon: "download",
          title: input.copy.t("toast.update.title"),
          description: input.copy.t("toast.update.description", { version: version ?? "" }),
          actions: [
            {
              label: input.copy.t("toast.update.action.installRestart"),
              onClick: async () => {
                await update()
              },
            },
            {
              label: input.copy.t("toast.update.action.notYet"),
              onClick: "dismiss",
            },
          ],
        })
      })

    createEffect(() => {
      if (!input.settings.ready()) return

      if (!input.settings.updates.startup()) {
        if (interval === undefined) return
        clearInterval(interval)
        interval = undefined
        return
      }

      if (interval !== undefined) return
      void pollUpdate()
      interval = setInterval(pollUpdate, 10 * 60 * 1000)
    })

    onCleanup(() => {
      if (interval === undefined) return
      clearInterval(interval)
    })
  })
}
