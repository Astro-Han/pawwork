import type { Accessor } from "solid-js"
import type { useCommand, CommandOption } from "@/context/command"
import type { Locale, useLanguage } from "@/context/language"
import type { ColorScheme, useTheme } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"

type LayoutCommandRegistration = {
  registry: Pick<ReturnType<typeof useCommand>, "register">
  copy: ReturnType<typeof useLanguage>
  appearance: ReturnType<typeof useTheme>
  viewActions: {
    toggleSidebar: () => void
  }
  navigationActions: {
    openProject: () => void
    moveProject: (offset: number) => void
    moveSession: (offset: number) => void
    moveUnseenSession: (offset: number) => void
  }
  settingsActions: {
    open: () => void
    canOpenGlobalConfigFolder: Accessor<boolean>
    openGlobalConfigFolder: () => void | Promise<void>
  }
  workspaceActions: {
    canCreateCurrent: Accessor<boolean>
    createCurrent: () => unknown
    canToggleCurrent: Accessor<boolean>
    toggleCurrent: () => boolean | undefined
  }
  systemActions: {
    connectProvider: () => void
    switchServer: () => void
  }
}

const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
  system: "theme.scheme.system",
  light: "theme.scheme.light",
  dark: "theme.scheme.dark",
}

export function registerLayoutCommands(input: LayoutCommandRegistration) {
  const {
    registry,
    copy,
    appearance,
    viewActions,
    navigationActions,
    settingsActions,
    workspaceActions,
    systemActions,
  } = input
  const colorSchemeLabel = (scheme: ColorScheme) => copy.t(colorSchemeKey[scheme])

  function cycleColorScheme(direction = 1) {
    const current = appearance.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    appearance.setColorScheme(next)
    showToast({
      title: copy.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === copy.locale()) return
    copy.setLocale(next)
    showToast({
      title: copy.t("toast.language.title"),
      description: copy.t("toast.language.description", { language: copy.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = copy.locales
    const currentIndex = locales.indexOf(copy.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  registry.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: copy.t("command.sidebar.toggle"),
        category: copy.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => viewActions.toggleSidebar(),
      },
      {
        id: "project.open",
        title: copy.t("command.project.open"),
        category: copy.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => navigationActions.openProject(),
      },
      {
        id: "project.previous",
        title: copy.t("command.project.previous"),
        category: copy.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigationActions.moveProject(-1),
      },
      {
        id: "project.next",
        title: copy.t("command.project.next"),
        category: copy.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigationActions.moveProject(1),
      },
      {
        id: "provider.connect",
        title: copy.t("command.provider.connect"),
        category: copy.t("command.category.provider"),
        onSelect: () => systemActions.connectProvider(),
      },
      {
        id: "server.switch",
        title: copy.t("command.server.switch"),
        category: copy.t("command.category.server"),
        onSelect: () => systemActions.switchServer(),
      },
      {
        id: "settings.open",
        title: copy.t("command.settings.open"),
        category: copy.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => settingsActions.open(),
      },
      {
        id: "settings.openGlobalConfigFolder",
        title: copy.t("command.settings.openGlobalConfigFolder"),
        category: copy.t("command.category.settings"),
        disabled: !settingsActions.canOpenGlobalConfigFolder(),
        onSelect: () => settingsActions.openGlobalConfigFolder(),
      },
      {
        id: "session.previous",
        title: copy.t("command.session.previous"),
        category: copy.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigationActions.moveSession(-1),
      },
      {
        id: "session.next",
        title: copy.t("command.session.next"),
        category: copy.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigationActions.moveSession(1),
      },
      {
        id: "session.previous.unseen",
        title: copy.t("command.session.previous.unseen"),
        category: copy.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigationActions.moveUnseenSession(-1),
      },
      {
        id: "session.next.unseen",
        title: copy.t("command.session.next.unseen"),
        category: copy.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigationActions.moveUnseenSession(1),
      },
      {
        id: "workspace.new",
        title: copy.t("workspace.new"),
        category: copy.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceActions.canCreateCurrent(),
        onSelect: () => workspaceActions.createCurrent(),
      },
      {
        id: "workspace.toggle",
        title: copy.t("command.workspace.toggle"),
        description: copy.t("command.workspace.toggle.description"),
        category: copy.t("command.category.workspace"),
        slash: "workspace",
        disabled: !workspaceActions.canToggleCurrent(),
        onSelect: () => {
          const wasEnabled = workspaceActions.toggleCurrent()
          if (wasEnabled === undefined) return
          showToast({
            title: wasEnabled
              ? copy.t("toast.workspace.disabled.title")
              : copy.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? copy.t("toast.workspace.disabled.description")
              : copy.t("toast.workspace.enabled.description"),
          })
        },
      },
    ]

    if (appearance.canSwitchColorScheme()) {
      commands.push({
        id: "theme.scheme.cycle",
        title: copy.t("command.theme.scheme.cycle"),
        category: copy.t("command.category.theme"),
        keybind: "mod+shift+s",
        onSelect: () => cycleColorScheme(1),
      })

      for (const scheme of colorSchemeOrder) {
        commands.push({
          id: `theme.scheme.${scheme}`,
          title: copy.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
          category: copy.t("command.category.theme"),
          onSelect: () => appearance.commitPreview(),
          onHighlight: () => {
            appearance.previewColorScheme(scheme)
            return () => appearance.cancelPreview()
          },
        })
      }
    }

    commands.push({
      id: "language.cycle",
      title: copy.t("command.language.cycle"),
      category: copy.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of copy.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: copy.t("command.language.set", { language: copy.label(locale) }),
        category: copy.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })
}
