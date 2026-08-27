import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { loadDshClientModule } from "./dsh-client-module.testing"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const clientEntry = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/web-search/lib/client.js")

type Element = { type: unknown; props: Record<string, unknown> }

function fakeDocument() {
  return {
    documentElement: { lang: "zh-CN" },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} },
  }
}

const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
  const nextProps = { ...props, children }
  return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
}

function visit(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(visit)
  if (!node || typeof node !== "object") return []
  const element = node as Element
  return [element, ...((element.props?.children as unknown[]) || []).flatMap(visit)]
}

function textOf(tree: unknown) {
  return visit(tree)
    .flatMap((element) => (element.props.children as unknown[] | undefined) ?? [])
    .filter((child): child is string => typeof child === "string")
    .join(" ")
}

/** A snapshot store standing in for the client runtime's. */
function fakeStore(value: unknown) {
  let current = value
  return { getSnapshot: () => current, set: (next: unknown) => { current = next }, subscribe: () => () => {} }
}

/** Load the plugin with the browser dependencies it declares. */
function loadPlugin(open: boolean) {
  const definition = loadDshClientModule(clientEntry, { document: fakeDocument() })
  return {
    definition,
    plugin: definition.factory((module: string) => {
      if (module === "react") return { createElement, useState: <T>(value: T) => [open ? true : value, () => {}] }
      if (module === "@deepseek-ai/dsh-client-ui-primitives") return { IconChevronDownOutline14: "IconChevronDown" }
      if (module === "@deepseek-ai/dsh-client-runtime/client") return { createSnapshotStore: fakeStore }
      throw new Error(`unexpected web-search client dependency: ${module}`)
    }),
  }
}

/** Mount the plugin and return the registered card plus what it was registered with. */
function cardOf(options: { section?: Record<string, unknown>; describe?: unknown } = {}) {
  const { definition, plugin } = loadPlugin(true)
  const snapshot: Record<string, unknown> = {
    status: "ready",
    writable: true,
    value: { backend: "exa" },
    user: undefined,
    base: {},
    ...options.section,
  }
  const registrations: Array<Record<string, unknown>> = []
  let card: ((props: Record<string, unknown>) => unknown) | undefined
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
  const credentials = {
    describe: vi.fn(async () => options.describe ?? { result: { ok: true, value: { credentials: {} } } }),
    set: vi.fn(async () => ({ result: { ok: true } })),
  }
  plugin.apply({
    get: (service: string) => (service === "connection" ? { api: { credentials } } : undefined),
    effect: (run: () => unknown) => run(),
    locale: { register: () => () => {} },
    remote: { $on: () => () => {} },
    settingsScope: { bind: () => scope },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (registration: Record<string, unknown>, component: typeof card) => {
        registrations.push(registration)
        card = component
        return () => {}
      },
    },
  })
  return { card: card!, credentials, definition, plugin, registrations, scope }
}

/** Render the card with a translator that echoes its keys' Chinese copy. */
function render(card: (props: Record<string, unknown>) => unknown, injected: Record<string, unknown>, t: (key: string) => string) {
  const store = injected.hooks as { webSearchCard: { getSnapshot: () => unknown } }
  return card({
    ...injected,
    t,
    useWebSearchCard: (select: (snapshot: unknown) => unknown) => select(store.webSearchCard.getSnapshot()),
  })
}

describe("PawWork DSH web search client", () => {
  test("registers one card, keyed to the namespace its plugin serves", () => {
    const { definition, plugin, registrations } = cardOf()

    expect(definition.id).toBe("@pawwork/dsh-web-search")
    expect(plugin.inject).toEqual(["slots", "locale", "connection", "remote", "settingsScope"])
    expect(registrations).toEqual([{
      name: "settings.plugin.item",
      key: "pawwork-web-search",
      locale: "pawwork-web-search",
      inject: expect.any(Function),
    }])
  })

  // Primitives ship no Select, and the Models page — the repository's own
  // authority for settings forms — uses the native control, so a hand-rolled
  // listbox would be the only menu in settings that is not the platform's.
  test("offers the three backends through the native select settings uses", () => {
    const { card, registrations } = cardOf()
    const injected = (registrations[0].inject as () => Record<string, unknown>)()

    const tree = render(card, injected, (key) => key)
    const select = visit(tree).find((element) => element.type === "select")
    const options = visit(select).filter((element) => element.type === "option")

    expect(select?.props.value).toBe("exa")
    expect(options.map((option) => option.props.value)).toEqual(["exa", "deepseek", "perplexity"])
  })

  // The section cannot say this; only the card knows the Exa backend answers
  // without a key, and a first-run user reading "search is unavailable" would
  // go looking for a key they do not need.
  test("tells an unconfigured Exa user that search already works", () => {
    const { card, registrations } = cardOf()
    const injected = (registrations[0].inject as () => Record<string, unknown>)()

    const tree = render(card, injected, (key) => key)

    expect(textOf(tree)).toContain("apiKeyUnsetFree")
    expect(textOf(tree)).toContain("keylessBadge")
    expect(textOf(tree)).not.toContain("apiKeyUnsetRequired")
  })

  test("tells an unconfigured Perplexity user that a key is required", () => {
    const { card, registrations } = cardOf({ section: { value: { backend: "perplexity" } } })
    const injected = (registrations[0].inject as () => Record<string, unknown>)()

    const tree = render(card, injected, (key) => key)

    expect(textOf(tree)).toContain("apiKeyUnsetRequired")
    expect(textOf(tree)).not.toContain("keylessBadge")
  })

  test("asks the credentials domain about the reference the selected backend resolves", () => {
    const { credentials } = cardOf()

    expect(credentials.describe).toHaveBeenCalledWith({ refs: ["EXA_API_KEY"] })
  })

  // The reference follows the backend, so a card that kept asking about the old
  // one would show "key configured" for a backend that holds none.
  test("re-reads the credential when the backend changes", () => {
    const { credentials, registrations } = cardOf()
    const injected = (registrations[0].inject as () => Record<string, unknown>)()

    ;(injected.selectBackend as (value: string) => void)("perplexity")

    expect(credentials.describe).toHaveBeenLastCalledWith({ refs: ["PERPLEXITY_API_KEY"] })
  })

  // A staged backend and a staged key are one edit to the user, so one save
  // covers both — and the key never travels through the settings document.
  test("saves the backend through settings and the key through credentials", async () => {
    const { credentials, registrations, scope } = cardOf()
    const injected = (registrations[0].inject as () => Record<string, unknown>)()
    scope.set.mockImplementation(async () => {})
    scope.getSnapshot = () => ({
      status: "ready",
      writable: true,
      value: { backend: "perplexity" },
      user: { backend: "perplexity" },
      base: {},
    })
    credentials.describe.mockResolvedValue({
      result: { ok: true, value: { credentials: { PERPLEXITY_API_KEY: { configured: true, writable: true } } } },
    })

    ;(injected.selectBackend as (value: string) => void)("perplexity")
    ;(injected.editKey as (text: string) => void)("a-key")
    await (injected.save as () => Promise<void>)()

    expect(scope.set).toHaveBeenCalledWith("backend", "perplexity")
    expect(credentials.set).toHaveBeenCalledWith({ ref: "PERPLEXITY_API_KEY", value: "a-key" })
  })

  // A blank key means "keep the current one", so saving one would clear a key
  // the user never touched.
  test("does not write a blank key", async () => {
    const { credentials, registrations, scope } = cardOf()
    const injected = (registrations[0].inject as () => Record<string, unknown>)()
    scope.getSnapshot = () => ({
      status: "ready", writable: true, value: { backend: "deepseek" }, user: { backend: "deepseek" }, base: {},
    })

    ;(injected.selectBackend as (value: string) => void)("deepseek")
    ;(injected.editKey as (text: string) => void)("   ")
    await (injected.save as () => Promise<void>)()

    expect(credentials.set).not.toHaveBeenCalled()
    expect(scope.set).toHaveBeenCalledWith("backend", "deepseek")
  })

  test("renders nothing until the Host serves the namespace", () => {
    const { card, registrations } = cardOf({ section: { status: "loading" } })
    const injected = (registrations[0].inject as () => Record<string, unknown>)()

    expect(render(card, injected, (key) => key)).toBeNull()
  })
})
