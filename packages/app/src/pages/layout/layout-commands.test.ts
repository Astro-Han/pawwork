import { describe, expect, test } from "bun:test"
import type { CommandOption, useCommand } from "@/context/command"
import type { useLanguage } from "@/context/language"
import type { useTheme } from "@opencode-ai/ui/theme/context"
import { registerLayoutCommands } from "./layout-commands"

function layoutCommandCatalog(input?: {
  canOpenGlobalConfigFolder?: boolean
  canCreateWorkspace?: boolean
  canToggleWorkspace?: boolean
  canSwitchColorScheme?: boolean
}) {
  let catalog: CommandOption[] = []
  registerLayoutCommands({
    registry: {
      register: (_scope, options) => {
        catalog = options()
      },
    } as Pick<ReturnType<typeof useCommand>, "register">,
    copy: {
      t: (key: string) => key,
      locale: () => "en",
      locales: ["en", "zh"],
      label: (locale: string) => locale,
      setLocale: () => undefined,
    } as unknown as ReturnType<typeof useLanguage>,
    appearance: {
      canSwitchColorScheme: () => input?.canSwitchColorScheme ?? true,
      colorScheme: () => "system",
      setColorScheme: () => undefined,
      commitPreview: () => undefined,
      previewColorScheme: () => undefined,
      cancelPreview: () => undefined,
    } as unknown as ReturnType<typeof useTheme>,
    viewActions: {
      toggleSidebar: () => undefined,
    },
    navigationActions: {
      openProject: () => undefined,
      moveProject: () => undefined,
      moveSession: () => undefined,
      moveUnseenSession: () => undefined,
    },
    settingsActions: {
      open: () => undefined,
      canOpenGlobalConfigFolder: () => input?.canOpenGlobalConfigFolder ?? true,
      openGlobalConfigFolder: () => undefined,
    },
    workspaceActions: {
      canCreateCurrent: () => input?.canCreateWorkspace ?? true,
      createCurrent: () => undefined,
      canToggleCurrent: () => input?.canToggleWorkspace ?? true,
      toggleCurrent: () => false,
    },
    systemActions: {
      connectProvider: () => undefined,
      switchServer: () => undefined,
    },
  })
  return catalog
}

describe("registerLayoutCommands", () => {
  test("keeps the layout command catalog shape stable", () => {
    const catalog = layoutCommandCatalog()

    expect(catalog.map((command) => command.id)).toEqual([
      "sidebar.toggle",
      "project.open",
      "project.previous",
      "project.next",
      "provider.connect",
      "server.switch",
      "settings.open",
      "settings.openGlobalConfigFolder",
      "session.previous",
      "session.next",
      "session.previous.unseen",
      "session.next.unseen",
      "workspace.new",
      "workspace.toggle",
      "theme.scheme.cycle",
      "theme.scheme.system",
      "theme.scheme.light",
      "theme.scheme.dark",
      "language.cycle",
      "language.set.en",
      "language.set.zh",
    ])

    expect(Object.fromEntries(catalog.map((command) => [command.id, command.keybind ?? null]))).toMatchObject({
      "sidebar.toggle": "mod+b",
      "project.open": "mod+o",
      "project.previous": "mod+alt+arrowup",
      "project.next": "mod+alt+arrowdown",
      "settings.open": "mod+comma",
      "session.previous": "alt+arrowup",
      "session.next": "alt+arrowdown",
      "session.previous.unseen": "shift+alt+arrowup",
      "session.next.unseen": "shift+alt+arrowdown",
      "workspace.new": "mod+shift+w",
      "theme.scheme.cycle": "mod+shift+s",
    })
    expect(catalog.find((command) => command.id === "workspace.toggle")?.slash).toBe("workspace")
  })

  test("reflects command availability from layout capabilities", () => {
    const catalog = layoutCommandCatalog({
      canOpenGlobalConfigFolder: false,
      canCreateWorkspace: false,
      canToggleWorkspace: false,
      canSwitchColorScheme: false,
    })

    expect(catalog.find((command) => command.id === "settings.openGlobalConfigFolder")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "workspace.new")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "workspace.toggle")?.disabled).toBe(true)
    expect(catalog.some((command) => command.id.startsWith("theme.scheme."))).toBe(false)
  })
})
