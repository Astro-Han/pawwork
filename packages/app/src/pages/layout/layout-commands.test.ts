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
  canOpenFiles?: boolean
  canMoveSession?: boolean
  canPrepareDiagnostics?: boolean
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
    paletteActions: {
      open: () => undefined,
      canOpenFiles: () => input?.canOpenFiles ?? true,
    },
    sessionActions: {
      openNew: () => undefined,
    },
    navigationActions: {
      openProject: () => undefined,
      moveProject: () => undefined,
      moveSession: () => undefined,
      moveUnseenSession: () => undefined,
      canMoveSession: () => input?.canMoveSession ?? true,
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
    diagnosticsActions: {
      prepare: () => undefined,
      canPrepare: () => input?.canPrepareDiagnostics ?? true,
    },
  })
  return catalog
}

describe("registerLayoutCommands", () => {
  test("keeps the layout command catalog shape stable", () => {
    const catalog = layoutCommandCatalog()

    expect(catalog.map((command) => command.id)).toEqual([
      "session.new",
      "file.open",
      "sidebar.toggle",
      "project.open",
      "project.previous",
      "project.next",
      "provider.connect",
      "server.switch",
      "settings.open",
      "settings.openGlobalConfigFolder",
      "diagnostics.prepare",
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
      // session.new shares mod+shift+s with theme.scheme.cycle; the runtime
      // keymap resolves by first occurrence, so session.new must come first.
      "session.new": "mod+shift+s",
      "file.open": "mod+k,mod+p",
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
    expect(catalog.find((command) => command.id === "session.new")?.slash).toBe("new")
    expect(catalog.find((command) => command.id === "file.open")?.slash).toBe("open")
  })

  test("reflects command availability from layout capabilities", () => {
    const catalog = layoutCommandCatalog({
      canOpenGlobalConfigFolder: false,
      canCreateWorkspace: false,
      canToggleWorkspace: false,
      canSwitchColorScheme: false,
      canOpenFiles: false,
      canMoveSession: false,
      canPrepareDiagnostics: false,
    })

    expect(catalog.find((command) => command.id === "settings.openGlobalConfigFolder")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "workspace.new")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "workspace.toggle")?.disabled).toBe(true)
    // Zero projects: the file picker has no directory to list, so file.open
    // disappears from the keymap, the palette list, and the suggested rows.
    expect(catalog.find((command) => command.id === "file.open")?.disabled).toBe(true)
    // Surface routes: session-relative navigation has no anchor session, so
    // alt+arrow keybinds must not yank the user off the page.
    expect(catalog.find((command) => command.id === "session.previous")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "session.next")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "session.previous.unseen")?.disabled).toBe(true)
    expect(catalog.find((command) => command.id === "session.next.unseen")?.disabled).toBe(true)
    expect(catalog.some((command) => command.id.startsWith("theme.scheme."))).toBe(false)
    // Non-desktop hosts have no prepareReport bridge, so the diagnostics entry
    // stays visible but disabled rather than firing a no-op.
    expect(catalog.find((command) => command.id === "diagnostics.prepare")?.disabled).toBe(true)
  })
})
