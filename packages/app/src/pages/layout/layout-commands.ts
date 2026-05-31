import type { Accessor } from "solid-js"
import type { LocalProject, useLayout } from "@/context/layout"
import type { useCommand, CommandOption } from "@/context/command"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { Locale, useLanguage } from "@/context/language"
import type { usePlatform } from "@/context/platform"
import type { ColorScheme, useTheme } from "@opencode-ai/ui/theme/context"
import { showToast } from "@opencode-ai/ui/toast"
import { errorMessage } from "./helpers"

type LayoutCommandRegistration = {
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
  layout: ReturnType<typeof useLayout>
  theme: ReturnType<typeof useTheme>
  platform: ReturnType<typeof usePlatform>
  globalSDK: ReturnType<typeof useGlobalSDK>
  currentProject: Accessor<LocalProject | undefined>
  workspaceSetting: Accessor<unknown>
  chooseProject: () => void
  navigateProjectByOffset: (offset: number) => void
  connectProvider: () => void
  openServer: () => void
  openSettings: () => void
  navigateSessionByOffset: (offset: number) => void
  navigateSessionByUnseen: (offset: number) => void
  createWorkspace: (project: LocalProject) => unknown
}

const colorSchemeOrder: ColorScheme[] = ["system", "light", "dark"]
const colorSchemeKey: Record<ColorScheme, "theme.scheme.system" | "theme.scheme.light" | "theme.scheme.dark"> = {
  system: "theme.scheme.system",
  light: "theme.scheme.light",
  dark: "theme.scheme.dark",
}

export function registerLayoutCommands(input: LayoutCommandRegistration) {
  const {
    command,
    language,
    layout,
    theme,
    platform,
    globalSDK,
    currentProject,
    workspaceSetting,
    chooseProject,
    navigateProjectByOffset,
    connectProvider,
    openServer,
    openSettings,
    navigateSessionByOffset,
    navigateSessionByUnseen,
    createWorkspace,
  } = input
  const colorSchemeLabel = (scheme: ColorScheme) => language.t(colorSchemeKey[scheme])

  function cycleColorScheme(direction = 1) {
    const current = theme.colorScheme()
    const currentIndex = colorSchemeOrder.indexOf(current)
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + colorSchemeOrder.length) % colorSchemeOrder.length
    const next = colorSchemeOrder[nextIndex]
    theme.setColorScheme(next)
    showToast({
      title: language.t("toast.scheme.title"),
      description: colorSchemeLabel(next),
    })
  }

  function setLocale(next: Locale) {
    if (next === language.locale()) return
    language.setLocale(next)
    showToast({
      title: language.t("toast.language.title"),
      description: language.t("toast.language.description", { language: language.label(next) }),
    })
  }

  function cycleLanguage(direction = 1) {
    const locales = language.locales
    const currentIndex = locales.indexOf(language.locale())
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + locales.length) % locales.length
    const next = locales[nextIndex]
    if (!next) return
    setLocale(next)
  }

  command.register("layout", () => {
    const commands: CommandOption[] = [
      {
        id: "sidebar.toggle",
        title: language.t("command.sidebar.toggle"),
        category: language.t("command.category.view"),
        keybind: "mod+b",
        onSelect: () => layout.sidebar.toggle(),
      },
      {
        id: "project.open",
        title: language.t("command.project.open"),
        category: language.t("command.category.project"),
        keybind: "mod+o",
        onSelect: () => chooseProject(),
      },
      {
        id: "project.previous",
        title: language.t("command.project.previous"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowup",
        onSelect: () => navigateProjectByOffset(-1),
      },
      {
        id: "project.next",
        title: language.t("command.project.next"),
        category: language.t("command.category.project"),
        keybind: "mod+alt+arrowdown",
        onSelect: () => navigateProjectByOffset(1),
      },
      {
        id: "provider.connect",
        title: language.t("command.provider.connect"),
        category: language.t("command.category.provider"),
        onSelect: () => connectProvider(),
      },
      {
        id: "server.switch",
        title: language.t("command.server.switch"),
        category: language.t("command.category.server"),
        onSelect: () => openServer(),
      },
      {
        id: "settings.open",
        title: language.t("command.settings.open"),
        category: language.t("command.category.settings"),
        keybind: "mod+comma",
        onSelect: () => openSettings(),
      },
      {
        id: "settings.openGlobalConfigFolder",
        title: language.t("command.settings.openGlobalConfigFolder"),
        category: language.t("command.category.settings"),
        disabled: !platform.openPath,
        onSelect: async () => {
          const target = await globalSDK.client.path
            .get({ ensureConfig: true })
            .then((x) => x.data?.config)
            .catch((err) => {
              showToast({
                title: language.t("toast.settings.openGlobalConfigFolderFailed.title"),
                description: errorMessage(err, language.t("common.requestFailed")),
                variant: "error",
              })
              return undefined
            })
          if (!target) return
          await platform.openPath?.(target).catch((err) => {
            showToast({
              title: language.t("toast.settings.openGlobalConfigFolderFailed.title"),
              description: errorMessage(err, language.t("common.requestFailed")),
              variant: "error",
            })
          })
        },
      },
      {
        id: "session.previous",
        title: language.t("command.session.previous"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowup",
        onSelect: () => navigateSessionByOffset(-1),
      },
      {
        id: "session.next",
        title: language.t("command.session.next"),
        category: language.t("command.category.session"),
        keybind: "alt+arrowdown",
        onSelect: () => navigateSessionByOffset(1),
      },
      {
        id: "session.previous.unseen",
        title: language.t("command.session.previous.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowup",
        onSelect: () => navigateSessionByUnseen(-1),
      },
      {
        id: "session.next.unseen",
        title: language.t("command.session.next.unseen"),
        category: language.t("command.category.session"),
        keybind: "shift+alt+arrowdown",
        onSelect: () => navigateSessionByUnseen(1),
      },
      {
        id: "workspace.new",
        title: language.t("workspace.new"),
        category: language.t("command.category.workspace"),
        keybind: "mod+shift+w",
        disabled: !workspaceSetting(),
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          return createWorkspace(project)
        },
      },
      {
        id: "workspace.toggle",
        title: language.t("command.workspace.toggle"),
        description: language.t("command.workspace.toggle.description"),
        category: language.t("command.category.workspace"),
        slash: "workspace",
        disabled: !currentProject() || currentProject()?.vcs !== "git",
        onSelect: () => {
          const project = currentProject()
          if (!project) return
          if (project.vcs !== "git") return
          const wasEnabled = layout.sidebar.workspaces(project.worktree)()
          layout.sidebar.toggleWorkspaces(project.worktree)
          showToast({
            title: wasEnabled
              ? language.t("toast.workspace.disabled.title")
              : language.t("toast.workspace.enabled.title"),
            description: wasEnabled
              ? language.t("toast.workspace.disabled.description")
              : language.t("toast.workspace.enabled.description"),
          })
        },
      },
    ]

    if (theme.canSwitchColorScheme()) {
      commands.push({
        id: "theme.scheme.cycle",
        title: language.t("command.theme.scheme.cycle"),
        category: language.t("command.category.theme"),
        keybind: "mod+shift+s",
        onSelect: () => cycleColorScheme(1),
      })

      for (const scheme of colorSchemeOrder) {
        commands.push({
          id: `theme.scheme.${scheme}`,
          title: language.t("command.theme.scheme.set", { scheme: colorSchemeLabel(scheme) }),
          category: language.t("command.category.theme"),
          onSelect: () => theme.commitPreview(),
          onHighlight: () => {
            theme.previewColorScheme(scheme)
            return () => theme.cancelPreview()
          },
        })
      }
    }

    commands.push({
      id: "language.cycle",
      title: language.t("command.language.cycle"),
      category: language.t("command.category.language"),
      onSelect: () => cycleLanguage(1),
    })

    for (const locale of language.locales) {
      commands.push({
        id: `language.set.${locale}`,
        title: language.t("command.language.set", { language: language.label(locale) }),
        category: language.t("command.category.language"),
        onSelect: () => setLocale(locale),
      })
    }

    return commands
  })
}
