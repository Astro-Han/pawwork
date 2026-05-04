import { createContext, useContext, type Accessor } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2/client"

export type ShellSurfaceContextValue = {
  settingsOpen: Accessor<boolean>
  openNewSession: (directory?: string) => void
  openSession: (session: Session | undefined) => void
  openSettings: () => void
  closeSettings: () => void
}

export const ShellSurfaceContext = createContext<ShellSurfaceContextValue>()

export function useShellSurface() {
  const value = useContext(ShellSurfaceContext)
  if (!value) throw new Error("ShellSurfaceContext is not available")
  return value
}
