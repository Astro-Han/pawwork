import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

// Remote access page. PR1 body is a placeholder so the nav entry is not empty and the whole thing ships.
// Later it gains the real remote-server connect / manage feature (the server part of the old Connections
// + Manage Servers).
export const RemotePage: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2 py-8">
      <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.remoteAccess")}</h2>
      <p class="text-body text-fg-weak">{language.t("settings.remote.placeholder")}</p>
    </div>
  )
}
