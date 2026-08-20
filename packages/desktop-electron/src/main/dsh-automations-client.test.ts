import { readFileSync } from "node:fs"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const automationsRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/automations")

describe("PawWork DSH Automations client", () => {
  test("declares one packaged DSH plugin", () => {
    const automationsPackage = JSON.parse(readFileSync(resolve(automationsRoot, "package.json"), "utf8"))

    expect(automationsPackage.name).toBe("@pawwork/dsh-automations")
    expect(automationsPackage.main).toBe("./lib/index.js")
    expect(automationsPackage.exports["./client"].default).toBe("./lib/client.js")
  })

  test("registers one Settings section as its management surface", () => {
    const document = {
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }

    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    expect(definition.id).toBe("@pawwork/dsh-automations")

    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return {}
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    const registrations: Array<{ id?: string; label?: () => string; name?: string; order?: number }> = []
    plugin.apply({
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; label?: () => string; name?: string; order?: number }) => {
          registrations.push(options)
          return () => {}
        },
      },
    })

    expect(plugin.inject).toEqual(["slots", "connection", "conversation", "sessions", "workspaces"])
    expect(registrations).toEqual([{
      id: "pawwork-automations",
      label: expect.any(Function),
      name: "settings.section",
      order: 40,
    }])
    expect(registrations[0].label?.()).toBe("自动化")
    document.documentElement.lang = "en"
    expect(registrations[0].label?.()).toBe("Automations")
  })

  test("creates through chat and closes Settings", async () => {
    const document = {
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })

    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
      const nextProps = { ...props, children }
      return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
    }
    const primitive = (type: string) => (props: Record<string, unknown>) => ({ type, props })
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => [value, () => {}],
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          Button: primitive("button"),
          Input: primitive("input"),
          Pill: primitive("button"),
          IconSearchOutline16: "IconSearchOutline16",
        }
      }
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    const connectWorkspace = vi.fn(async () => "session-1")
    const setDraft = vi.fn(() => {})
    const open = vi.fn(() => {})
    plugin.apply({
      connection: {},
      conversation: { input: { for: () => ({ setDraft }) } },
      sessions: { binding: () => ({ ctx: {} }), open },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => {
          settingsSection = component
          return () => {}
        },
      },
      workspaces: { connectWorkspace },
    })

    const close = vi.fn(() => {})
    const tree = settingsSection!({
      close,
      useWorkspaces: (select: (state: unknown) => unknown) => select({
        items: [{ workspaceId: "workspace-1" }],
        recentWorkspaceId: "workspace-1",
      }),
    })
    const visit = (node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(node)) return node.flatMap(visit)
      if (!node || typeof node !== "object") return []
      const element = node as { type: unknown; props: Record<string, unknown> }
      return [element, ...((element.props?.children as unknown[]) || []).flatMap(visit)]
    }
    const createButton = visit(tree).find((element) =>
      element.type === "button" && (element.props.children as unknown[] | undefined)?.includes("在对话中创建"),
    )

    expect(createButton).toBeDefined()
    await (createButton!.props.onClick as () => Promise<void>)()
    expect(connectWorkspace).toHaveBeenCalledWith("workspace-1")
    expect(setDraft).toHaveBeenCalledWith("帮我创建一个自动化。先问我它要做什么、什么时候运行，再帮我创建。")
    expect(open).toHaveBeenCalledWith("session-1")
    expect(close).toHaveBeenCalledTimes(1)
  })

  test("opens a completed run session and closes Settings", async () => {
    const document = {
      documentElement: { lang: "en" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })

    const definitionData = {
      id: "automation-1",
      title: "Daily summary",
      prompt: "Summarize the workspace",
      revision: 1,
      paused: false,
      context: "fresh",
      cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "deepseek-v4-flash-free" },
      timezone: "UTC",
      kind: "recurring",
      rhythm: { kind: "interval", everyMs: 86_400_000 },
      stop: { kind: "never" },
      nextFireAt: Date.now() + 86_400_000,
      recentRuns: [{
        id: "automation-run-1",
        state: "succeeded",
        triggeredAt: Date.now(),
        sessionId: "session-1",
        result: "Done",
      }],
    }
    let stateCall = 0
    const setEditorError = vi.fn(() => {})
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
      const nextProps = { ...props, children }
      return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
    }
    const primitive = (type: string) => (props: Record<string, unknown>) => ({ type, props })
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            if (stateCall === 1) return [{ definitions: [definitionData] }, () => {}]
            if (stateCall === 2) return [definitionData.id, () => {}]
            if (stateCall === 9) return [value, setEditorError]
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          Button: primitive("button"), DisclosureRow: primitive("div"), Input: primitive("input"),
          Menu: primitive("div"), Modal: primitive("div"), Pill: primitive("button"), StateDot: primitive("span"),
          IconChevronLeftOutline14: "IconChevronLeftOutline14", IconChevronDownOutline14: "IconChevronDownOutline14",
          IconPauseOutline16: "IconPauseOutline16", IconPlayOutline16: "IconPlayOutline16",
          IconSearchOutline16: "IconSearchOutline16", IconSettingsOutline16: "IconSettingsOutline16",
          IconTrashOutline16: "IconTrashOutline16",
        }
      }
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    let sessionsRefreshed = false
    const open = vi.fn(() => {
      if (!sessionsRefreshed) throw new Error("session registry is stale")
    })
    const refresh = vi.fn(async () => { sessionsRefreshed = true })
    plugin.apply({
      connection: {}, conversation: {}, sessions: { open, refresh }, workspaces: {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
      },
    })
    const close = vi.fn(() => {})
    const tree = settingsSection!({
      close,
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const visit = (node: unknown): Array<{ type: unknown; props: Record<string, unknown> }> => {
      if (Array.isArray(node)) return node.flatMap(visit)
      if (!node || typeof node !== "object") return []
      const element = node as { type: unknown; props: Record<string, unknown> }
      return [element, ...((element.props?.children as unknown[]) || []).flatMap(visit)]
    }
    const openSession = visit(tree).find((element) =>
      element.type === "button" && (element.props.children as unknown[] | undefined)?.includes("Open session"),
    )

    expect(openSession).toBeDefined()
    await (openSession!.props.onClick as () => Promise<void>)()
    expect(open).toHaveBeenCalledWith("session-1")
    expect(close).toHaveBeenCalledTimes(1)

    sessionsRefreshed = false
    refresh.mockImplementationOnce(async () => {})
    close.mockClear()
    await expect((openSession!.props.onClick as () => Promise<void>)()).resolves.toBeUndefined()
    expect(close).not.toHaveBeenCalled()
    expect(setEditorError).toHaveBeenCalledWith(expect.stringContaining("session registry is stale"))
  })
})
