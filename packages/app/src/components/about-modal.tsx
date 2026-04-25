import { onCleanup, onMount } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"

import { useLanguage } from "@/context/language"

export type AboutInfo = {
  version: string
  electronVersion: string
  chromeVersion: string
  buildSha: string
}

function AboutDialogBody(props: { info: AboutInfo }) {
  const language = useLanguage()
  return (
    <Dialog title={language.t("about.title")} class="w-full max-w-[400px] mx-auto">
      <dl class="text-sm space-y-1 p-6 pt-0">
        <div>
          <dt class="inline">{language.t("about.version")}: </dt>
          <dd class="inline">{props.info.version}</dd>
        </div>
        <div>
          <dt class="inline">{language.t("about.build")}: </dt>
          <dd class="inline">{props.info.buildSha}</dd>
        </div>
        <div>
          <dt class="inline">{language.t("about.electron")}: </dt>
          <dd class="inline">{props.info.electronVersion}</dd>
        </div>
        <div>
          <dt class="inline">{language.t("about.chromium")}: </dt>
          <dd class="inline">{props.info.chromeVersion}</dd>
        </div>
      </dl>
    </Dialog>
  )
}

export function AboutModal() {
  const dialog = useDialog()
  let unsubscribe: (() => void) | undefined

  onMount(() => {
    unsubscribe = window.api?.onAboutOpen?.(async () => {
      let info: AboutInfo | undefined
      try {
        info = await window.api?.getAboutInfo?.()
      } catch (error) {
        console.warn("[about] failed to fetch info", error)
        return
      }
      if (!info) return
      const data = info
      dialog.show(() => <AboutDialogBody info={data} />)
    })
  })

  onCleanup(() => unsubscribe?.())

  return null
}
