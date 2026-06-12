import { createContext, useContext, type Accessor } from "solid-js"
import type { SettingsTab } from "@/pages/settings/settings-shell"

// Wiring the layout shell hands to the three surface route components
// (/settings /automations /skills). They render as the layout's children, so
// directory resolution, project scoping and close-to-origin stay owned by the
// shell and the route components stay thin.
export type SurfacePageContextValue = {
  close: () => void
  settings: {
    tab: Accessor<SettingsTab>
    directory: Accessor<string>
  }
  automations: {
    directory: Accessor<string>
    projectID: Accessor<string | undefined>
    openRun: (sessionID: string) => void
    openProject: () => void
    createViaChat: () => void
  }
  skills: {
    directory: Accessor<string>
    useInChat: (name: string) => void
  }
}

export const SurfacePageContext = createContext<SurfacePageContextValue>()

export function useSurfacePage() {
  const value = useContext(SurfacePageContext)
  if (!value) throw new Error("SurfacePageContext is not available")
  return value
}
