import { createContext, useContext, type Accessor } from "solid-js"

export type ShellSurfaceContextValue = {
  settingsOpen: Accessor<boolean>
  openSettings: () => void
  closeSettings: () => void
}

export const ShellSurfaceContext = createContext<ShellSurfaceContextValue>()

export function useShellSurface() {
  const value = useContext(ShellSurfaceContext)
  if (!value) throw new Error("ShellSurfaceContext is not available")
  return value
}
