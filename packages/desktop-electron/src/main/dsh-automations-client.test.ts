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
  Button: primitive("button"), Input: primitive("PrimitiveInput"),
  Modal: primitive("div"), Pill: primitive("button"), StateDot: primitive("span"),
  useAnchoredPosition: () => null, useDismissOnOutsidePointer: () => {},
  IconChevronLeftOutline14: "IconChevronLeftOutline14", IconChevronRightOutline14: "IconChevronRightOutline14",
  IconChevronDownOutline14: "IconChevronDownOutline14",
  IconCheckOutline16: "IconCheckOutline16",
  IconPauseOutline16: "IconPauseOutline16", IconPlayOutline16: "IconPlayOutline16",
  IconSearchOutline16: "IconSearchOutline16", IconTrashOutline16: "IconTrashOutline16",
}

function settingsSectionOf(
  plugin: { apply: (ctx: Record<string, unknown>) => void },
  ctx: Record<string, unknown> = {},
) {
  let section: ((props: unknown) => unknown) | undefined
  plugin.apply({
    connection: {}, conversation: {}, sessions: {}, ...ctx,
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (_options: unknown, component: typeof section) => { section = component; return () => {} },
    },
  })
  return section!
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

    expect(plugin.inject).toEqual(["slots", "connection", "conversation", "remote", "remote.session", "sessions", "uiWorkspace"])
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

  // The panel header above already carries the shell's actions and Close, so the section's primary
  // action lives in the toolbar with the controls it acts on, not in a second cluster below them.
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
    const connectWorkspace = vi.fn(async () => "session-1")
    const setDraft = vi.fn(() => {})
    const open = vi.fn(() => {})
    const settingsSection = settingsSectionOf(plugin, {
      conversation: { input: { for: () => ({ setDraft }) } },
      sessions: { binding: () => ({ ctx: {} }), open },
      uiWorkspace: { connectWorkspace },
    })

    const close = vi.fn(() => {})
    const tree = settingsSection({
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

  // Glyph and trailing text come from one derivation, so they cannot disagree about whether a
  // schedule is still live: a stopped one used to render a play glyph next to "Next —".
  test.each([
    [{ id: "live", paused: false, nextFireAt: 4_000, terminalReason: null }, "下次", "IconPlayOutline16"],
    [{ id: "paused", paused: true, nextFireAt: null, terminalReason: null }, "已暂停", "IconPauseOutline16"],
    [{ id: "done", paused: false, nextFireAt: null, terminalReason: "completed" }, "已完成", "IconCheckOutline16"],
    [{ id: "limit", paused: false, nextFireAt: null, terminalReason: "run-limit" }, "已跑满", "IconCheckOutline16"],
    [{ id: "missed", paused: false, nextFireAt: null, terminalReason: "missed" }, "已错过", "IconCheckOutline16"],
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
    const settingsSection = settingsSectionOf(plugin)

    const tree = settingsSection({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const row = visit(tree).find((element) => element.props.className === "pawwork-automation-row")

    expect(row).toBeDefined()
    expect(textOf(row).join(" ")).toContain(label)
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
    const settingsSection = settingsSectionOf(plugin)

    const tree = settingsSection({
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
      const call = vi.fn(async () => ({ ok: true, value: definitionData }))
      const settingsSection = settingsSectionOf(plugin, { connection: { rpc: { call } } })

      const tree = settingsSection({
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

  // The cron rule is too big to mirror in the renderer, so the store codes its refusal and the
  // editor carries the copy: untyped, a Chinese UI showed the store's English sentence.
  test.each([
    ["invalid-cron", "invalid cron expression: 0 9 30 2 *", "Cron 表达式无效，或它指定的时间永远不会到来"],
  ])("localizes a store refusal coded %s instead of showing the store's sentence", async (code, message, copy) => {
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
    const call = vi.fn(async () => ({
      ok: false,
      error: { code: "bad-request", message, details: { issues: [{ code }] } },
    }))
    const settingsSection = settingsSectionOf(plugin, { connection: { rpc: { call } } })

    const tree = settingsSection({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
    await (form!.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
      preventDefault: () => {},
    })

    expect(written).toContain(copy)
    expect(written.some((entry) => typeof entry === "string" && entry.includes(message))).toBe(false)
  })

  // A model is picked from the catalog the composer's seat offers, not typed. A definition
  // pinned to a pair the catalog dropped still opens on that pair, marked but unchanged, and
  // the run history says which model each run actually used.
  test("offers the routable model catalog and marks a pinned model the catalog no longer lists", () => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    const definitionData = {
      id: "automation-1", title: "Weekly digest", prompt: "Summarize the week", revision: 4,
      paused: false, context: "fresh", cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "deepseek-v4-flash-free" }, timezone: "UTC",
      kind: "recurring", rhythm: { kind: "cron", expression: "0 9 * * 3" }, stop: { kind: "never" },
      recentRuns: [{
        id: "automation-run-1", state: "succeeded", triggeredAt: 0, sessionId: "session-1", result: "Done",
        modelFallback: { requested: { provider: "opencode", model: "deepseek-v4-flash-free" }, used: { provider: "opencode", model: "big-pickle" } },
      }],
    }
    const catalog = {
      routableProviders: ["opencode", "opencode-responses"],
      groups: [{ id: "opencode", name: "OpenCode", models: [{ id: "big-pickle", name: "Big Pickle" }, { id: "mimo-v2.5-free", name: "MiMo V2.5" }] }],
      failures: [{ id: "custom", name: "Custom", message: "ECONNREFUSED" }],
    }
    // Hooks by position: the section's data, selected id, then its catalog is the sixth; the
    // editor's "advanced" disclosure is its own sixth hook, opened so the model field renders.
    // The catalog effect is the only one keyed on the editor being open, and it must ask the
    // remote exactly once.
    let stateCall = 0
    const formWrites: Array<(current: Record<string, string>) => Record<string, string>> = []
    let formState: Record<string, string> | undefined
    const catalogWrites: unknown[] = []
    const modelCatalog = vi.fn(async () => ({ ok: true, value: catalog }))
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: (effect: () => void, deps?: unknown[]) => { if (deps?.[0] === true) effect() },
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            if (stateCall === 1) return [{ definitions: [definitionData] }, () => {}]
            if (stateCall === 2) return [definitionData.id, () => {}]
            if (stateCall === 6) return [catalog, (next: unknown) => catalogWrites.push(next)]
            if (stateCall === 7) {
              formState = formState ?? (value as Record<string, string>)
              return [formState, (next: unknown) => formWrites.push(next as (current: Record<string, string>) => Record<string, string>)]
            }
            if (stateCall === 12) return [true, () => {}]
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    const settingsSection = settingsSectionOf(plugin, { remote: { session: { modelCatalog } } })

    const tree = settingsSection({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
    const fields = visit(form)
    const modelSelect = fields.find((element) => element.type === "select" && element.props["aria-label"] === "模型")

    expect(fields.some((element) => element.type === "input" && element.props["aria-label"] === "模型来源")).toBe(false)
    expect(modelSelect).toBeDefined()
    const options = visit(modelSelect).filter((element) => element.type === "option")
    expect(options.map((option) => option.props.children)).toEqual([
      ["opencode/deepseek-v4-flash-free (未列出，运行时改用默认模型)"], ["Big Pickle"], ["MiMo V2.5"],
    ])
    expect(modelSelect!.props.value).toBe(options[0].props.value)
    // A native select clips option text to its field, so the model field takes the whole row.
    expect(fields.find((element) => String(element.props.className).includes("pawwork-automation-group") && visit(element).includes(modelSelect!))?.props.className)
      .toBe("pawwork-automation-group pawwork-automation-group-wide")
    expect(visit(modelSelect).map((element) => element.props.label).filter(Boolean)).toEqual(["OpenCode"])
    // The catalog is already loaded, so opening the editor must not ask for it again.
    expect(modelCatalog).not.toHaveBeenCalled()
    expect(formWrites).toHaveLength(0)

    ;(modelSelect!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: options[2].props.value as string } })
    expect(formWrites).toHaveLength(1)
    expect(formWrites[0]({ provider: "opencode", model: "deepseek-v4-flash-free", title: "Weekly digest" }))
      .toEqual({ provider: "opencode", model: "mimo-v2.5-free", title: "Weekly digest" })

    const runTexts = textOf(tree)
    expect(runTexts).toContain("模型 opencode/deepseek-v4-flash-free 不可用，本次运行使用 opencode/big-pickle")
    expect(runTexts).toContain("Done")

    // After the form moved to a listed model the definition's pair is still offered, so the
    // user can move back to it without discarding the rest of the edit. Run now works on the
    // saved definition, so an unsaved model choice blocks it like it blocks Pause.
    stateCall = 0
    formState = { ...formState, provider: "opencode", model: "mimo-v2.5-free" }
    const movedTree = visit(settingsSection({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    }))
    const movedSelect = movedTree.find((element) => element.type === "select" && element.props["aria-label"] === "模型")
    const movedOptions = visit(movedSelect).filter((element) => element.type === "option")
    expect(movedOptions.map((option) => option.props.children)).toEqual([
      ["opencode/deepseek-v4-flash-free (未列出，运行时改用默认模型)"], ["Big Pickle"], ["MiMo V2.5"],
    ])
    expect(movedSelect!.props.value).toBe(movedOptions[2].props.value)
    const runNow = movedTree.find((element) => element.type === "button" && textOf(element).includes("立即运行"))
    expect(runNow?.props.disabled).toBe(true)
    expect(runNow?.props.title).toBe("请先保存更改")
  })

  // The label follows the run rule: with nothing routable the adapter gives no verdict and the
  // run keeps its pair, a provider whose list failed keeps it too, and any other unlisted pair
  // is moved to the default model whether its provider is routable or gone.
  test.each([
    ["custom", { routableProviders: ["opencode", "custom"], groups: [], failures: [{ id: "custom", name: "Custom", message: "ECONNREFUSED" }] }, "暂时无法列出，运行时仍使用"],
    ["removed-route", { routableProviders: ["opencode"], groups: [], failures: [] }, "未列出，运行时改用默认模型"],
    ["opencode", { routableProviders: [], groups: [], failures: [] }, "当前没有可用模型"],
  ])("labels a %s model by what the catalog proves", (provider, catalog, label) => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    const definitionData = {
      id: "automation-1", title: "Weekly digest", prompt: "Summarize the week", revision: 4,
      paused: false, context: "fresh", cwd: "/tmp/workspace",
      model: { provider, model: "anything" }, timezone: "UTC",
      kind: "recurring", rhythm: { kind: "cron", expression: "0 9 * * 3" }, stop: { kind: "never" }, recentRuns: [],
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
            if (stateCall === 6) return [catalog, () => {}]
            if (stateCall === 12) return [true, () => {}]
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    const tree = settingsSectionOf(plugin)({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const modelSelect = visit(tree).find((element) => element.type === "select" && element.props["aria-label"] === "模型")

    expect(visit(modelSelect).filter((element) => element.type === "option").map((option) => option.props.children))
      .toEqual([[`${provider}/anything (${label})`]])
  })

  // The list poll clears the section's error every second, so a catalog failure parked there
  // vanished and the select said "loading" forever. The failure lands in the catalog state
  // itself, and the select reports it without calling the pinned model unavailable.
  test("says the model list failed instead of loading forever", async () => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    const definitionData = {
      id: "automation-1", title: "Weekly digest", prompt: "Summarize the week", revision: 4,
      paused: false, context: "fresh", cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "big-pickle" }, timezone: "UTC",
      kind: "recurring", rhythm: { kind: "cron", expression: "0 9 * * 3" }, stop: { kind: "never" }, recentRuns: [],
    }
    let stateCall = 0
    const catalogWrites: unknown[] = []
    const modelCatalog = vi.fn(async () => ({ ok: false, error: Object.assign(new Error("catalog offline"), { code: "internal" }) }))
    // Runs an effect only when its dependencies changed, as React does, so a fetch per render
    // would fail here instead of passing as "asked again".
    const effectDeps = new Map<number, unknown[]>()
    let effectCall = 0
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: (effect: () => void, deps?: unknown[]) => {
            effectCall += 1
            if (deps?.[0] !== true) return
            const previous = effectDeps.get(effectCall)
            if (previous && previous.every((entry, index) => Object.is(entry, deps[index]))) return
            effectDeps.set(effectCall, deps)
            effect()
          },
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(value: T) => {
            stateCall += 1
            if (stateCall === 1) return [{ definitions: [definitionData] }, () => {}]
            if (stateCall === 2) return [definitionData.id, () => {}]
            if (stateCall === 6) return [catalogWrites.length ? catalogWrites[0] : null, (next: unknown) => catalogWrites.push(next)]
            if (stateCall === 12) return [true, () => {}]
            return [value, () => {}]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives
      throw new Error(`unexpected Automations client dependency: ${name}`)
    })
    const settingsSection = settingsSectionOf(plugin, { remote: { session: { modelCatalog } } })
    const props = {
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    }
    const selectOptions = (tree: unknown) => {
      const modelSelect = visit(tree).find((element) => element.type === "select" && element.props["aria-label"] === "模型")
      return visit(modelSelect).filter((element) => element.type === "option").map((option) => option.props.children)
    }

    expect(selectOptions(settingsSection(props))).toEqual([["opencode/big-pickle (正在加载模型…)"]])
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    expect(catalogWrites).toEqual([{ groups: [], routableProviders: [], failures: [], error: "catalog offline" }])
    stateCall = 0; effectCall = 0
    expect(selectOptions(settingsSection(props))).toEqual([["opencode/big-pickle (模型列表加载失败)"]])
    // Re-rendering with the editor still open does not ask again.
    expect(modelCatalog).toHaveBeenCalledTimes(1)
    // A failure is not a value: the next editor open asks again.
    effectDeps.clear(); stateCall = 0; effectCall = 0
    settingsSection(props)
    expect(modelCatalog).toHaveBeenCalledTimes(2)
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
    const call = vi.fn(async () => ({ ok: true, value: definitionData }))
    const settingsSection = settingsSectionOf(plugin, { connection: { rpc: { call } } })

    const tree = settingsSection({
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
    let sessionsRefreshed = false
    const open = vi.fn(() => {
      if (!sessionsRefreshed) throw new Error("session registry is stale")
    })
    const refresh = vi.fn(async () => { sessionsRefreshed = true })
    const settingsSection = settingsSectionOf(plugin, { sessions: { open, refresh } })
    const close = vi.fn(() => {})
    const tree = settingsSection({
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

  // The browser's own datetime picker is neither themed nor placed inside the settings panel, so a
  // one-shot schedule is edited as a themed date field plus a time field. Splitting the value is
  // where it can silently drift: half the timestamp is written by each control.
  test("edits a one-shot schedule without the browser's datetime picker, and saves the same instant", async () => {
    const document = fakeDocument("zh-CN")
    const definition = loadDshClientModule(resolve(automationsRoot, "lib/client.js"), { document })
    // The editor refuses a one-shot time in the past, so this instant has to stay ahead of the run.
    // Local noon, because the round trip goes through a local date and a local time: an instant near
    // a DST transition would come back as a different one, or as one that does not exist.
    const week = new Date(Date.now() + 7 * 86_400_000)
    const fireAt = new Date(week.getFullYear(), week.getMonth(), week.getDate(), 12).getTime()
    const definitionData = {
      id: "automation-1", title: "复查 PR", prompt: "Check the PR", revision: 4,
      paused: true, context: "fresh", cwd: "/tmp/workspace",
      model: { provider: "opencode", model: "deepseek-v4-flash-free" }, timezone: "Asia/Shanghai",
      kind: "oneshot", fireAt, recentRuns: [],
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
    const call = vi.fn(async () => ({ ok: true, value: definitionData }))
    const settingsSection = settingsSectionOf(plugin, { connection: { rpc: { call } } })

    const tree = settingsSection({
      close: () => {},
      useWorkspaces: (select: (state: unknown) => unknown) => select({ items: [], recentWorkspaceId: null }),
    })
    const form = visit(tree).find((element) => typeof element.props.onSubmit === "function")
    const fields = visit(form)

    // The Input primitive is an inline-flex content box; sizing one to a form column pushes its own
    // padding and border past that column, so the editor's fields are the plain boxes DSH's own
    // settings editor uses, and the primitive stays on the toolbar search that needs its icon slot.
    expect(fields.some((element) => element.type === "PrimitiveInput")).toBe(false)
    expect(fields.some((element) => element.type === "input" && element.props.type === "datetime-local")).toBe(false)
    expect(fields.some((element) => element.type === "input" && element.props.type === "time")).toBe(true)
    expect(fields.some((element) => element.type === "select")).toBe(true)

    await (form!.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
      preventDefault: () => {},
    })

    expect(call).toHaveBeenCalledWith(
      "/pawwork-automations", "update", expect.objectContaining({ fireAt }), undefined,
    )
  })
})
