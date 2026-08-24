import { readFileSync } from "node:fs"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const automationsRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/automations")

type Element = { type: unknown; props: Record<string, unknown> }

function fakeDocument(lang: string) {
  return {
    documentElement: { lang },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} },
  }
}

// The plugin builds its tree with h(), so calling a function component inline
// renders it eagerly: the result is the whole tree, already flattened.
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
  const nextProps = { ...props, children }
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
}

const primitive = (type: string) => (props: Record<string, unknown>) => ({ type, props })

function visit(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(visit)
  if (!node || typeof node !== "object") return []
  const element = node as Element
  return [element, ...((element.props?.children as unknown[]) || []).flatMap(visit)]
}

function textOf(tree: unknown) {
  return visit(tree).flatMap((element) => (element.props.children as unknown[] | undefined) ?? [])
    .filter((child): child is string => typeof child === "string")
}

const primitives = {
  Button: primitive("button"), DisclosureRow: primitive("div"), Input: primitive("input"),
  Menu: primitive("div"), Modal: primitive("div"), Pill: primitive("button"), StateDot: primitive("span"),
  IconChevronLeftOutline14: "IconChevronLeftOutline14", IconChevronDownOutline14: "IconChevronDownOutline14",
  IconCheckOutline16: "IconCheckOutline16",
  IconPauseOutline16: "IconPauseOutline16", IconPlayOutline16: "IconPlayOutline16",
  IconSearchOutline16: "IconSearchOutline16", IconSettingsOutline16: "IconSettingsOutline16",
  IconTrashOutline16: "IconTrashOutline16",
}

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

  // The settings panel header already carries the shell's own actions and Close, so the section's
  // primary action lives in the toolbar with the controls it acts on — not in a second cluster
  // 8px below them. Where it sits and what it does are one fact about one button.
  test("creates through chat from the toolbar", async () => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })

    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => [value, () => {}],
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
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
    const head = visit(tree).find((element) => element.props.className === "pawwork-automations-page-head")
    const toolbar = visit(tree).find((element) => element.props.className === "pawwork-automations-toolbar")
    const createButton = visit(toolbar).find((element) =>
      element.type === "button" && (element.props.children as unknown[] | undefined)?.includes("新建自动化"),
    )

    expect(head).toBeDefined()
    expect(visit(head).some((element) => element.type === "button")).toBe(false)
    expect(createButton).toBeDefined()
    await (createButton!.props.onClick as () => Promise<void>)()
    expect(connectWorkspace).toHaveBeenCalledWith("workspace-1")
    expect(setDraft).toHaveBeenCalledWith("帮我创建一个自动化。先问我它要做什么、什么时候运行，再帮我创建。")
    expect(open).toHaveBeenCalledWith("session-1")
    expect(close).toHaveBeenCalledTimes(1)
  })

  // A definition that has stopped for good used to render as a play glyph next to "Next —", which
  // reads as one still waiting its turn. The glyph and the trailing text now come from one
  // derivation, so they cannot disagree about whether a schedule is still live.
  test.each([
    [{ id: "live", paused: false, nextFireAt: 4_000, terminalReason: null }, "下次", "IconPlayOutline16"],
    [{ id: "paused", paused: true, nextFireAt: null, terminalReason: null }, "已暂停", "IconPauseOutline16"],
    [{ id: "done", paused: false, nextFireAt: null, terminalReason: "completed" }, "已完成", "IconCheckOutline16"],
    [{ id: "limit", paused: false, nextFireAt: null, terminalReason: "run-limit" }, "已跑满", "IconCheckOutline16"],
  ])("states $id in the row's glyph and its trailing text alike", (state, label, glyph) => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    let stateCall = 0
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            if (stateCall === 1) {
              return [{ definitions: [{
                ...state,
                title: "Weekly digest",
                prompt: "Summarize the week",
                revision: 1,
                context: "fresh",
                cwd: "/tmp/workspace",
                model: { provider: "opencode", model: "deepseek-v4-flash-free" },
                timezone: "UTC",
                kind: "recurring",
                rhythm: { kind: "cron", expression: "0 9 * * *" },
                stop: { kind: "never" },
                recentRuns: [],
              }] }, () => {}]
            }
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    plugin.apply({
      connection: {}, conversation: {}, sessions: {}, workspaces: {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
      },
    })

    const tree = settingsSection!({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const row = visit(tree).find((element) => element.props.className === "pawwork-automation-row")

    expect(textOf(tree).join(" ")).toContain(label)
    expect(visit(row).some((element) => element.type === glyph)).toBe(true)
  })

  // The list label, the editor form and the save path each read this mapping.
  // Stated three times they had already drifted: the form round-tripped a weekly
  // expression it wrote itself, while the list showed it as "Cron 0 9 * * 3".
  test.each([
    ["zh-CN", "0 9 * * *", "每天 09:00"],
    ["zh-CN", "30 18 * * 1-5", "工作日 18:30"],
    ["zh-CN", "0 9 * * 3", "每周三 09:00"],
    ["zh-CN", "0 9 * * 0", "每周日 09:00"],
    ["en", "0 9 * * 3", "Wednesdays 09:00"],
    ["en", "0 9 1 * *", "Cron 0 9 1 * *"],
    ["en", "*/5 * * * *", "Cron */5 * * * *"],
  ])("labels %s cron %s as %s", (lang, expression, label) => {
    const document = fakeDocument(lang)
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    // The section's first hook holds what it loaded; nothing else is selected,
    // so the tree is the list and the label under test is in it.
    let stateCall = 0
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            if (stateCall === 1) {
              return [{ definitions: [{
                id: "automation-1",
                title: "Weekly digest",
                prompt: "Summarize the week",
                revision: 1,
                paused: false,
                context: "fresh",
                cwd: "/tmp/workspace",
                model: { provider: "opencode", model: "deepseek-v4-flash-free" },
                timezone: "UTC",
                kind: "recurring",
                rhythm: { kind: "cron", expression },
                stop: { kind: "never" },
                recentRuns: [],
              }] }, () => {}]
            }
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    plugin.apply({
      connection: {}, conversation: {}, sessions: {}, workspaces: {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
      },
    })

    const tree = settingsSection!({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })

    // The row renders the schedule beside the title and the next fire time in its own column.
    expect(textOf(tree).join(" ")).toContain(label)
  })

  // The other half of the same mapping: the editor writes back what it read.
  // Only the write path can catch a preset that stops carrying the weekday the
  // user chose, because the label never sees the form.
  test.each([
    ["0 9 * * *", undefined],
    ["30 18 * * 1-5", undefined],
    ["0 9 * * 3", undefined],
    ["0 9 * * 0", undefined],
    ["0 9 * * 3", { kind: "count", count: 3 }],
  ] as const)(
    "saves the schedule it opened with, unchanged, for cron %s",
    async (expression, stop) => {
      const document = fakeDocument("en")
      const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
      const definitionData = {
        id: "automation-1",
        title: "Weekly digest",
        prompt: "Summarize the week",
        revision: 4,
        paused: false,
        context: "fresh",
        cwd: "/tmp/workspace",
        model: { provider: "opencode", model: "deepseek-v4-flash-free" },
        timezone: "UTC",
        kind: "recurring",
        rhythm: { kind: "cron", expression },
        stop: stop ?? { kind: "never" },
        recentRuns: [],
      }
      let stateCall = 0
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
              return [value, () => {}]
            },
          }
        }
        if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
        throw new Error(`unexpected Automations client dependency: ${name}`)
      })
      let settingsSection: ((props: unknown) => unknown) | undefined
      const call = vi.fn(async () => ({ ok: true, value: definitionData }))
      plugin.apply({
        connection: { rpc: { call } }, conversation: {}, sessions: {}, workspaces: {},
        slots: {
          inject: (_name: string, register: () => void) => register(),
          register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
        },
      })

      const tree = settingsSection!({
        close: () => {},
        useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
      })
      // The editor opens with the form it derived from the definition, so
      // submitting it untouched sends that definition's schedule back.
      const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
      expect(form).toBeDefined()
      await (form!.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
        preventDefault: () => {},
      })

      expect(call).toHaveBeenCalledWith(
        "/pawwork-automations",
        "update",
        expect.objectContaining({ rhythm: { kind: "cron", expression }, stop: stop ?? { kind: "never" } }),
        undefined,
      )
    },
  )

  // The cron rule is too big to mirror in the renderer — that would mean copying the parser — so
  // the store codes its refusal and the editor carries the copy. Untyped, a Chinese UI showed the
  // store's English sentence, the same failure the interval floor was mirrored to avoid.
  test("localizes a refused cron expression instead of showing the store's sentence", async () => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    const definitionData = {
      id: "automation-1", title: "Weekly digest", prompt: "Summarize the week", revision: 4,
      paused: false, context: "fresh", cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "deepseek-v4-flash-free" }, timezone: "UTC",
      kind: "recurring", rhythm: { kind: "cron", expression: "0 9 * * *" },
      stop: { kind: "never" }, recentRuns: [],
    }
    const written: unknown[] = []
    let stateCall = 0
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            const write = (next: unknown) => { written.push(next) }
            if (stateCall === 1) return [{ definitions: [definitionData] }, write]
            if (stateCall === 2) return [definitionData.id, write]
            return [value, write]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    const call = vi.fn(async () => ({
      ok: false,
      error: {
        code: "bad-request",
        message: "invalid cron expression: 0 9 30 2 *",
        details: { issues: [{ code: "invalid-cron" }] },
      },
    }))
    plugin.apply({
      connection: { rpc: { call } }, conversation: {}, sessions: {}, workspaces: {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
      },
    })

    const tree = settingsSection!({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
    await (form!.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
      preventDefault: () => {},
    })

    expect(written).toContain("Cron 表达式无效，或它指定的时间永远不会到来")
    expect(written.some((entry) => typeof entry === "string" && entry.includes("invalid cron expression"))).toBe(false)
  })

  // "0" is truthy as a string, so an emptiness check sent stop.count = 0 and the
  // user met the backend's untranslated rejection instead of the editor's.
  test("refuses a run limit of zero instead of sending it to the backend", async () => {
    const document = fakeDocument("en")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    const definitionData = {
      id: "automation-1", title: "Weekly digest", prompt: "Summarize the week", revision: 4,
      paused: false, context: "fresh", cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "deepseek-v4-flash-free" }, timezone: "UTC",
      kind: "recurring", rhythm: { kind: "cron", expression: "0 9 * * 3" },
      stop: { kind: "count", count: 0 }, recentRuns: [],
    }
    let stateCall = 0
    const stateWrites: unknown[] = []
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
            return [value, (next: unknown) => stateWrites.push(next)]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    let settingsSection: ((props: unknown) => unknown) | undefined
    const call = vi.fn(async () => ({ ok: true, value: definitionData }))
    plugin.apply({
      connection: { rpc: { call } }, conversation: {}, sessions: {}, workspaces: {},
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (_options: unknown, component: typeof settingsSection) => { settingsSection = component },
      },
    })

    const tree = settingsSection!({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
    await (form!.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
      preventDefault: () => {},
    })

    expect(call).not.toHaveBeenCalled()
    expect(stateWrites).toContainEqual("Run count must be at least 1")
  })

  test("opens a completed run session and closes Settings", async () => {
    const document = fakeDocument("en")
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
    // Only the first two hooks are keyed by position, and they are the outer
    // section's own: the loaded data and the selected id. Every other setter
    // records what it was handed, so the error assertion does not depend on
    // which hook inside the editor happens to hold it.
    let stateCall = 0
    const stateWrites: unknown[] = []
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
            return [value, (next: unknown) => stateWrites.push(next)]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
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
    expect(stateWrites).toContainEqual(expect.stringContaining("session registry is stale"))
  })
})
