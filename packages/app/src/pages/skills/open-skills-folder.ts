import { showToast } from "@opencode-ai/ui/toast"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { usePlatform } from "@/context/platform"
import type { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"

// Opens the update-safe user skills folder (~/.agents/skills). The server owns
// the path and creates it on demand (ensureSkills), so the renderer never has to
// know where it lives or mkdir it; this mirrors createOpenGlobalConfigFolder.
export function createOpenSkillsFolder(input: {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  platform: Pick<ReturnType<typeof usePlatform>, "openPath">
  language: Pick<ReturnType<typeof useLanguage>, "t">
}): () => Promise<void> {
  const fail = (err: unknown) =>
    showToast({
      title: input.language.t("toast.skills.openFolderFailed.title"),
      description: errorMessage(err, input.language.t("common.requestFailed")),
      variant: "error",
    })

  return async function openSkillsFolder() {
    const target = await input.globalSDK.client.path
      .get({ ensureSkills: true })
      .then((x) => x.data?.skills)
      .catch((err) => {
        fail(err)
        return undefined
      })
    if (!target) return
    await input.platform.openPath?.(target).catch(fail)
  }
}
