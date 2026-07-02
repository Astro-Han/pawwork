import type { SettingsTab } from "../settings/settings-shell"
import { newSessionRoute, openSessionRoute } from "./helpers"

export type ShellNavigationReleaseReason = "new-session" | "session" | "settings" | "choose-project"

export type ShellNavigationSession = {
  directory: string
  id: string
}

export function createShellNavigation(input: {
  navigate: (route: string) => void
  releaseTransientLocks: (reason: ShellNavigationReleaseReason) => void
  resolveProjectRoot: (directory: string) => string | undefined
  currentProjectRoot: () => string | undefined
  directStartRoot?: () => string | undefined
  chooseProject: () => void
  openSettingsSurface: (tab?: SettingsTab) => void
}) {
  const resolveNewSessionRoot = (directory?: string) => {
    if (directory) return input.resolveProjectRoot(directory)
    return input.currentProjectRoot() || input.directStartRoot?.()
  }

  const openNewSession = (directory?: string) => {
    const root = resolveNewSessionRoot(directory)
    if (!root) {
      input.releaseTransientLocks("choose-project")
      input.chooseProject()
      return
    }
    input.releaseTransientLocks("new-session")
    input.navigate(newSessionRoute(root))
  }

  const openSession = (session: ShellNavigationSession | undefined) => {
    if (!session) return
    input.releaseTransientLocks("session")
    input.navigate(openSessionRoute(session.directory, session.id))
  }

  const openSettings = (tab?: SettingsTab) => {
    input.releaseTransientLocks("settings")
    input.openSettingsSurface(tab)
  }

  return {
    openNewSession,
    openSession,
    openSettings,
  }
}
