import { useSurfacePage } from "@/pages/layout/surface-page-context"
import { SettingsContent } from "./settings-shell"

// /settings route. The tab state and the sidebar's settings nav stay in the
// layout shell (the nav renders in the sidebar slot); this page is the
// matching main-area content.
export default function SettingsRoute() {
  const surface = useSurfacePage()
  return (
    <SettingsContent active={surface.settings.tab()} directory={surface.settings.directory()} onClose={surface.close} />
  )
}
