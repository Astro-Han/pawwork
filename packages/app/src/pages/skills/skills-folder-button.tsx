import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useLanguage } from "@/context/language"
import { canOpenLocalPath, type usePlatform } from "@/context/platform"
import { createOpenSkillsFolder } from "./open-skills-folder"

// Opening the folder needs a local filesystem, so only the desktop host (which
// can resolve and reveal paths) renders the action. Extracted from the surface
// so the gate and click wiring can be rendered and asserted in isolation,
// without standing up the gallery's resource and dialog dependencies.
export function OpenSkillsFolderButton(props: {
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client">
  platform: Pick<ReturnType<typeof usePlatform>, "openPath">
  language: Pick<ReturnType<typeof useLanguage>, "t">
}) {
  const open = createOpenSkillsFolder(props)
  return (
    <Show when={canOpenLocalPath(props.platform)}>
      <Button
        variant="secondary"
        icon="folder-open"
        data-action="skill-open-folder"
        class="h-9"
        onClick={() => void open()}
      >
        {props.language.t("skills.openFolder")}
      </Button>
    </Show>
  )
}
