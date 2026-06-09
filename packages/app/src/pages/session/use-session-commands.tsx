import { useNavigate } from "@solidjs/router"
import { createMediaQuery } from "@solid-primitives/media"
import { useCommand, type CommandOption } from "@/context/command"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { previewSelectedLines } from "@opencode-ai/ui/pierre/selection-bridge"
import { useFile, selectionFromLines, type FileSelection, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { usePermission } from "@/context/permission"
import { canUseBrowser, usePlatform } from "@/context/platform"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { showToast } from "@opencode-ai/ui/toast"
import { isWorkInFlightStatus } from "@opencode-ai/ui/util/session-status"
import { findLast } from "@opencode-ai/util/array"
import { canCloseSessionTab, closeSessionTab } from "@/pages/session/close-session-tab"
import { createSessionTabs } from "@/pages/session/helpers"
import { readSessionMessages, readUserMessages } from "@/pages/session/session-messages"
import { createCloseShellTabRouter, focusActiveTerminalTab, toggleDesktopTerminal } from "@/pages/session/terminal-shell-tab"
import { extractPromptFromParts } from "@/utils/prompt"
import { UserMessage } from "@opencode-ai/sdk/v2"
import { useSessionLayout } from "@/pages/session/session-layout"
import { emitRendererDiagnostic, sessionAbortDiagnosticEvent } from "@/context/renderer-diagnostics"
import { shareSessionCommand, unshareSessionCommand } from "@/pages/session/session-share-command"
import { rendererAbortDiagnosticSource } from "@/session/abort-source"
import { toAbsoluteFilePath } from "@/components/prompt-input/path-canonical"

export type SessionCommandContext = {
  navigateMessageByOffset: (offset: number) => void
  setActiveMessage: (message: UserMessage | undefined) => void
  focusInput: () => void
  review?: () => boolean
}

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useSessionCommands = (actions: SessionCommandContext) => {
  const command = useCommand()
  const dialog = useDialog()
  const file = useFile()
  const language = useLanguage()
  const local = useLocal()
  const permission = usePermission()
  const prompt = usePrompt()
  const sdk = useSDK()
  const sync = useSync()
  const terminal = useTerminal()
  const layout = useLayout()
  const platform = usePlatform()
  const navigate = useNavigate()
  const { params, tabs, view } = useSessionLayout()
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const info = () => {
    const id = params.id
    if (!id) return
    return sync.session.get(id)
  }
  const hasReview = () => !!params.id
  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: actions.review,
    hasReview,
  })
  const activeFileTab = tabState.activeFileTab
  const closableTab = tabState.closableTab

  const idle = { type: "idle" as const }
  const status = () => sync.data.session_status[params.id ?? ""] ?? idle
  const messages = () => {
    const id = params.id
    return readSessionMessages(id ? sync.data.message[id] : undefined)
  }
  const userMessages = () => readUserMessages(messages())
  const visibleUserMessages = () => {
    const revert = info()?.revert?.messageID
    if (!revert) return userMessages()
    return userMessages().filter((m) => m.id < revert)
  }

  const showAllFiles = () => {
    if (view().sidePanel.explorer.tab() !== "changes") return
    view().sidePanel.explorer.setTab("all")
  }

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addSelectionToContext = (path: string, selection: FileSelection) => {
    const preview = selectionPreview(path, selection)
    prompt.context.add({ type: "file", path: toAbsoluteFilePath(sdk.directory, path), selection, preview })
  }

  const canAddSelectionContext = () => {
    const tab = activeFileTab()
    if (!tab) return false
    const path = file.pathFromTab(tab)
    if (!path) return false
    return file.selectedLines(path) != null
  }

  const navigateMessageByOffset = actions.navigateMessageByOffset
  const setActiveMessage = actions.setActiveMessage
  const focusInput = actions.focusInput

  const sessionCommand = withCategory(language.t("command.category.session"))
  const fileCommand = withCategory(language.t("command.category.file"))
  const contextCommand = withCategory(language.t("command.category.context"))
  const viewCommand = withCategory(language.t("command.category.view"))
  const terminalCommand = withCategory(language.t("command.category.terminal"))
  const modelCommand = withCategory(language.t("command.category.model"))
  const mcpCommand = withCategory(language.t("command.category.mcp"))
  const agentCommand = withCategory(language.t("command.category.agent"))
  const permissionsCommand = withCategory(language.t("command.category.permissions"))

  const isAutoAcceptActive = () => {
    const sessionID = params.id
    if (sessionID) return permission.isAutoAccepting(sessionID, sdk.directory)
    return permission.isAutoAcceptingDirectory(sdk.directory)
  }
  const share = async () => {
    await shareSessionCommand({
      sessionID: params.id,
      existingUrl: info()?.share?.url,
      client: sdk.client.session,
      language,
    })
  }

  const unshare = async () => {
    await unshareSessionCommand({
      sessionID: params.id,
      client: sdk.client.session,
      language,
    })
  }

  const openFile = (source?: "palette" | "keybind" | "slash") => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode={source === "slash" ? "files" : undefined} onOpenFile={showAllFiles} />)
    })
  }

  const closeShellTabRouter = createCloseShellTabRouter({ view, terminal: () => terminal })

  const closeTab = () => {
    closeSessionTab({
      closableTab,
      closeFileTab: tabs().close,
      sidePanelOpened: view().sidePanel.opened,
      sidePanelTab: view().sidePanel.tab,
      // Route terminal:<id> closes to terminal.close so mod+w doesn't leave
      // orphan terminals in terminal.all(). Earlier this used
      // view().sidePanel.closeTab directly, which only shifts focus.
      closeShellTab: closeShellTabRouter,
    })
  }

  const addSelection = () => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (!path) return

    const range = file.selectedLines(path) as SelectedLineRange | null | undefined
    if (!range) {
      showToast({
        title: language.t("toast.context.noLineSelection.title"),
        description: language.t("toast.context.noLineSelection.description"),
      })
      return
    }

    addSelectionToContext(path, selectionFromLines(range))
  }

  // Both handlers are desktop-only: terminal.new / terminal.toggle are not
  // registered on narrow layouts (see viewCmds / terminalCmds), so neither
  // their keybind nor a palette entry can reach here when !isDesktop().
  // Post-flatten the whole terminal surface lives in the desktop-only right
  // panel; there is no non-desktop terminal host to drive.
  const openTerminal = () => {
    // Create a brand new terminal and switch to its outer tab. After flatten,
    // every terminal is its own right-panel tab; "open" means "make a new one
    // active".
    terminal.new()
    focusActiveTerminalTab(view().sidePanel, terminal)
  }

  const toggleTerminal = () => {
    toggleDesktopTerminal(view(), terminal)
  }

  const chooseModel = () => {
    void import("@/components/prompt-input/model-picker").then((x) => {
      x.openModelPicker()
    })
  }

  const chooseMcp = () => {
    void import("@/components/dialog-select-mcp").then((x) => {
      dialog.show(() => <x.DialogSelectMcp />)
    })
  }

  const toggleAutoAccept = () => {
    const sessionID = params.id
    if (sessionID) permission.toggleAutoAccept(sessionID, sdk.directory)
    else permission.toggleAutoAcceptDirectory(sdk.directory)

    const active = sessionID
      ? permission.isAutoAccepting(sessionID, sdk.directory)
      : permission.isAutoAcceptingDirectory(sdk.directory)
    showToast({
      title: active
        ? language.t("toast.permissions.autoaccept.on.title")
        : language.t("toast.permissions.autoaccept.off.title"),
      description: active
        ? language.t("toast.permissions.autoaccept.on.description")
        : language.t("toast.permissions.autoaccept.off.description"),
    })
  }

  const undo = async () => {
    const sessionID = params.id
    if (!sessionID) return

    if (isWorkInFlightStatus(status())) {
      await sdk.client.session
        .abort({ sessionID, source: rendererAbortDiagnosticSource({ sessionID, source: "undo" }) })
        .then((result) => {
          void emitRendererDiagnostic(
            sessionAbortDiagnosticEvent({
              routeSessionID: sessionID,
              visibleSessionID: sessionID,
              timelineSessionID: sessionID,
              source: "undo",
              result: result.data === false ? "ignored_awaiting_question" : "aborted",
            }),
          ).catch(() => undefined)
        })
        .catch(() => {})
    }

    const revert = info()?.revert?.messageID
    const message = findLast(userMessages(), (x) => !revert || x.id < revert)
    if (!message) return

    await sdk.client.session.revert({ sessionID, messageID: message.id })
    const parts = sync.data.part[message.id]
    if (parts) {
      const restored = extractPromptFromParts(parts, { directory: sdk.directory })
      prompt.set(restored)
    }

    const prev = findLast(userMessages(), (x) => x.id < message.id)
    setActiveMessage(prev)
  }

  const redo = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const revertMessageID = info()?.revert?.messageID
    if (!revertMessageID) return

    const next = userMessages().find((x) => x.id > revertMessageID)
    if (!next) {
      await sdk.client.session.unrevert({ sessionID })
      prompt.reset()
      const last = findLast(userMessages(), (x) => x.id >= revertMessageID)
      setActiveMessage(last)
      return
    }

    await sdk.client.session.revert({ sessionID, messageID: next.id })
    const prev = findLast(userMessages(), (x) => x.id < next.id)
    setActiveMessage(prev)
  }

  const compact = async () => {
    const sessionID = params.id
    if (!sessionID) return

    const model = local.model.current()
    if (!model) {
      showToast({
        title: language.t("toast.model.none.title"),
        description: language.t("toast.model.none.description"),
      })
      return
    }

    await sdk.client.session.summarize({
      sessionID,
      modelID: model.id,
      providerID: model.provider.id,
    })
  }

  const fork = () => {
    void import("@/components/dialog-fork").then((x) => {
      dialog.show(() => <x.DialogFork />)
    })
  }

  const shareCmds = () => {
    if (sync.data.config.share === "disabled") return []
    return [
      sessionCommand({
        id: "session.share",
        title: info()?.share?.url ? language.t("session.share.copy.copyLink") : language.t("command.session.share"),
        description: info()?.share?.url
          ? language.t("toast.session.share.success.description")
          : language.t("command.session.share.description"),
        slash: "share",
        disabled: !params.id,
        onSelect: share,
      }),
      sessionCommand({
        id: "session.unshare",
        title: language.t("command.session.unshare"),
        description: language.t("command.session.unshare.description"),
        slash: "unshare",
        disabled: !params.id || !info()?.share?.url,
        onSelect: unshare,
      }),
    ]
  }

  const sessionCmds = () => [
    sessionCommand({
      id: "session.new",
      title: language.t("command.session.new"),
      keybind: "mod+shift+s",
      slash: "new",
      onSelect: () => navigate(`/${params.dir}/session`),
    }),
    sessionCommand({
      id: "session.undo",
      title: language.t("command.session.undo"),
      description: language.t("command.session.undo.description"),
      slash: "undo",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: undo,
    }),
    sessionCommand({
      id: "session.redo",
      title: language.t("command.session.redo"),
      description: language.t("command.session.redo.description"),
      slash: "redo",
      disabled: !params.id || !info()?.revert?.messageID,
      onSelect: redo,
    }),
    sessionCommand({
      id: "session.compact",
      title: language.t("command.session.compact"),
      description: language.t("command.session.compact.description"),
      slash: "compact",
      // Server rejects compact-while-busy with Session.BusyError (mapped to 400).
      // Hide the slash entry and grey the command-palette row so the route is
      // only reachable from idle; bypass paths (CLI / scripts) still get the
      // honest 400 instead of the pre-fix silent success.
      disabled: !params.id || visibleUserMessages().length === 0 || isWorkInFlightStatus(status()),
      onSelect: compact,
    }),
    sessionCommand({
      id: "session.fork",
      title: language.t("command.session.fork"),
      description: language.t("command.session.fork.description"),
      slash: "fork",
      disabled: !params.id || visibleUserMessages().length === 0,
      onSelect: fork,
    }),
  ]

  const fileCmds = () => [
    fileCommand({
      id: "file.open",
      title: language.t("command.file.open"),
      description: language.t("palette.search.placeholder"),
      keybind: "mod+k,mod+p",
      slash: "open",
      onSelect: openFile,
    }),
    fileCommand({
      id: "tab.close",
      title: language.t("command.tab.close"),
      keybind: "mod+w",
      disabled: !canCloseSessionTab(closableTab, view().sidePanel.opened, view().sidePanel.tab),
      onSelect: closeTab,
    }),
  ]

  const contextCmds = () => [
    contextCommand({
      id: "context.addSelection",
      title: language.t("command.context.addSelection"),
      description: language.t("command.context.addSelection.description"),
      keybind: "mod+shift+l",
      disabled: !canAddSelectionContext(),
      onSelect: addSelection,
    }),
  ]

  const viewCmds = () => [
    // Terminal is a desktop-only surface after the flatten: the entire right
    // panel (its only host) is gated by isDesktop. On narrow layouts the
    // toggle would flip legacy view().terminal state with nothing to render,
    // so don't register the command or its keybind there at all. Same gate
    // on terminal.new below. The registration is reactive, so resizing across
    // 768px re-registers correctly.
    ...(isDesktop()
      ? [
          viewCommand({
            id: "terminal.toggle",
            title: language.t("command.terminal.toggle"),
            keybind: "ctrl+`",
            slash: "terminal",
            onSelect: toggleTerminal,
          }),
        ]
      : []),
    viewCommand({
      id: "review.toggle",
      title: language.t("command.review.toggle"),
      keybind: "mod+shift+r",
      onSelect: () => view().sidePanel.toggleTab("review"),
    }),
    // Embedded browser is desktop/Electron only (WebContentsView); like
    // terminal it has no host on web or narrow layouts, so don't register the
    // command or its keybind there. Reactive, so it re-registers across 768px.
    ...(isDesktop() && canUseBrowser(platform)
      ? [
          viewCommand({
            id: "browser.toggle",
            title: language.t("command.browser.toggle"),
            keybind: "mod+shift+b",
            onSelect: () => view().sidePanel.toggleTab("browser"),
          }),
        ]
      : []),
    viewCommand({
      id: "panel.toggle",
      title: language.t("command.panel.toggle"),
      description: language.t("command.panel.toggle.description"),
      keybind: "alt+mod+b",
      onSelect: () => view().sidePanel.toggle(),
    }),
    viewCommand({
      id: "input.focus",
      title: language.t("command.input.focus"),
      keybind: "ctrl+l",
      onSelect: focusInput,
    }),
  ]

  const terminalCmds = () =>
    isDesktop()
      ? [
          terminalCommand({
            id: "terminal.new",
            title: language.t("command.terminal.new"),
            description: language.t("command.terminal.new.description"),
            keybind: "ctrl+alt+t",
            onSelect: openTerminal,
          }),
        ]
      : []

  const messageCmds = () => [
    sessionCommand({
      id: "message.previous",
      title: language.t("command.message.previous"),
      description: language.t("command.message.previous.description"),
      keybind: "mod+alt+[",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(-1),
    }),
    sessionCommand({
      id: "message.next",
      title: language.t("command.message.next"),
      description: language.t("command.message.next.description"),
      keybind: "mod+alt+]",
      disabled: !params.id,
      onSelect: () => navigateMessageByOffset(1),
    }),
  ]

  const modelCmds = () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => local.model.variant.cycle(),
    }),
  ]

  const mcpCmds = () => [
    mcpCommand({
      id: "mcp.toggle",
      title: language.t("command.mcp.toggle"),
      description: language.t("command.mcp.toggle.description"),
      keybind: "mod+;",
      slash: "mcp",
      onSelect: chooseMcp,
    }),
  ]

  const agentCmds = () => [
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      onSelect: () => local.agent.move(-1),
    }),
  ]

  const permissionsCmds = () => [
    permissionsCommand({
      id: "permissions.autoaccept",
      title: isAutoAcceptActive()
        ? language.t("command.permissions.autoaccept.disable")
        : language.t("command.permissions.autoaccept.enable"),
      keybind: "mod+shift+a",
      disabled: false,
      onSelect: toggleAutoAccept,
    }),
  ]

  command.register("session", () => [
    ...sessionCmds(),
    ...shareCmds(),
    ...fileCmds(),
    ...contextCmds(),
    ...viewCmds(),
    ...terminalCmds(),
    ...messageCmds(),
    ...modelCmds(),
    ...mcpCmds(),
    ...agentCmds(),
    ...permissionsCmds(),
  ])
}
