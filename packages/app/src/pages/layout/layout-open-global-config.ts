import { showToast } from "@opencode-ai/ui/toast"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { usePlatform } from "@/context/platform"
import type { useLanguage } from "@/context/language"
import { errorMessage } from "./helpers"

export function createOpenGlobalConfigFolder(input: {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  platform: Pick<ReturnType<typeof usePlatform>, "openPath">
  language: Pick<ReturnType<typeof useLanguage>, "t">
}): () => Promise<void> {
  return async function openGlobalConfigFolder() {
    const target = await input.globalSDK.client.path
      .get({ ensureConfig: true })
      .then((x) => x.data?.config)
      .catch((err) => {
        showToast({
          title: input.language.t("toast.settings.openGlobalConfigFolderFailed.title"),
          description: errorMessage(err, input.language.t("common.requestFailed")),
          variant: "error",
        })
        return undefined
      })
    if (!target) return
    await input.platform.openPath?.(target).catch((err) => {
      showToast({
        title: input.language.t("toast.settings.openGlobalConfigFolderFailed.title"),
        description: errorMessage(err, input.language.t("common.requestFailed")),
        variant: "error",
      })
    })
  }
}
