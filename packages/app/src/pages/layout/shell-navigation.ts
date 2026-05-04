import { newSessionRoute, openSessionRoute } from "./helpers"

export type ShellNavigationReleaseReason = "new-session" | "session" | "settings" | "project" | "choose-project"

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
  openSettingsSurface: () => void
}) {
  const resolveNewSessionRoot = (directory?: string) => {
    if (directory) return input.resolveProjectRoot(directory)
    return input.currentProjectRoot()
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

  const openSettings = () => {
    input.releaseTransientLocks("settings")
    input.openSettingsSurface()
  }

  return {
    openNewSession,
    openSession,
    openSettings,
  }
}
