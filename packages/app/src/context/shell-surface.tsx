import { createContext, useContext, type Accessor } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"
import type { SettingsTab } from "../pages/settings/settings-shell"

export type ShellSurfaceContextValue = {
  settingsOpen: Accessor<boolean>
  automationsOpen: Accessor<boolean>
  skillsOpen: Accessor<boolean>
  // True while any main-region takeover surface (settings / automations /
  // skills) covers the session. Single source of truth for "the session and its
  // right panel are hidden", so titlebar/sidebar chrome that belongs to the
  // covered session retracts uniformly instead of each call site re-deriving it.
  mainSurfaceOpen: Accessor<boolean>
  openNewSession: (directory?: string) => void
  openSession: (session: Session | undefined) => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  openSkills: () => void
  closeSkills: () => void
}

export const ShellSurfaceContext = createContext<ShellSurfaceContextValue>()

export function useShellSurface() {
  const value = useContext(ShellSurfaceContext)
  if (!value) throw new Error("ShellSurfaceContext is not available")
  return value
}
