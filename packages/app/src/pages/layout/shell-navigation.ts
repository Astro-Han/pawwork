import type { SettingsPageTab } from "../../components/settings-page"
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
  chooseProject: () => void
  openSettingsSurface: (tab?: SettingsPageTab) => void
  closeSettingsSurface: () => void
}) {
  const resolveNewSessionRoot = (directory?: string) => {
    if (directory) return input.resolveProjectRoot(directory)
    return input.currentProjectRoot()
  }

  const openNewSession = (directory?: string) => {
    input.closeSettingsSurface()
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
    input.closeSettingsSurface()
    input.releaseTransientLocks("session")
    input.navigate(openSessionRoute(session.directory, session.id))
  }

  const openSettings = (tab?: SettingsPageTab) => {
    input.releaseTransientLocks("settings")
    input.openSettingsSurface(tab)
  }

  return {
    openNewSession,
    openSession,
    openSettings,
  }
}
