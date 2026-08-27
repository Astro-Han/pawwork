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

/** A snapshot store standing in for the client runtime's. */
function fakeStore(value: unknown) {
  let current = value
  return { getSnapshot: () => current, set: (next: unknown) => { current = next }, subscribe: () => () => {} }
}

/**
 * Load the plugin with exactly the browser dependencies it declares.
 *
 * The `require` stub throws on anything else on purpose: the primitives package
 * is host-provided and unresolvable from this repository, so a new import added
 * to the card would otherwise reach a user's machine unverified.
 */
function loadPlugin() {
  const definition = loadDshClientModule(clientEntry, { document: fakeDocument() })
  return {
    definition,
    plugin: definition.factory((module: string) => {
      if (module === "react") return { createElement, useState: <T>(value: T) => [value === false ? true : value, () => {}] }
      if (module === "@deepseek-ai/dsh-client-ui-primitives") {
        return { IconChevronDownOutline14: "IconChevronDown", Menu: "Menu" }
      }
      if (module === "@deepseek-ai/dsh-client-runtime/client") return { createSnapshotStore: fakeStore }
      throw new Error(`unexpected web-search client dependency: ${module}`)
    }),
  }
}

type CardActions = {
  discard: () => void
  editKey: (text: string) => void
  hooks: { webSearchCard: { getSnapshot: () => Record<string, unknown> } }
  resetBackend: () => Promise<void> | void
  save: () => Promise<void>
  selectBackend: (id: string) => void
}

type CardOptions = {
  section?: Record<string, unknown>
  describe?: unknown
  set?: () => Promise<unknown>
  setCredential?: () => Promise<unknown>
  unset?: () => Promise<unknown>
}

/** Mount the plugin and return the registered card plus the wires behind it. */
function cardOf(options: CardOptions = {}) {
  const { definition, plugin } = loadPlugin()
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
    set: vi.fn(async (key: string, value: unknown) => {
      if (options.set !== undefined) await options.set()
      snapshot.user = { ...(snapshot.user as object), [key]: value }
      snapshot.value = { ...(snapshot.value as object), [key]: value }
    }),
    unset: vi.fn(async () => {
      if (options.unset !== undefined) await options.unset()
    }),
  }
  const credentials = {
    describe: vi.fn(async () => options.describe ?? { result: { ok: true, value: { credentials: {} } } }),
    set: vi.fn(async () => (options.setCredential === undefined ? { result: { ok: true } } : options.setCredential())),
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
  const injected = (registrations[0]?.inject as () => CardActions)()
  return { card: card!, credentials, definition, injected, plugin, registrations, scope }
}

/** Render the card with a translator that echoes locale keys. */
function render(card: (props: Record<string, unknown>) => unknown, injected: CardActions) {
  const store = injected.hooks as { webSearchCard: { getSnapshot: () => unknown } }
  return card({
    ...injected,
    t: (key: string) => key,
    useWebSearchCard: (select: (snapshot: unknown) => unknown) => select(store.webSearchCard.getSnapshot()),
  })
}

/** @returns the state the card would render right now. */
function stateOf(injected: CardActions) {
  const store = injected.hooks as { webSearchCard: { getSnapshot: () => Record<string, unknown> } }
  return store.webSearchCard.getSnapshot()
}

describe("PawWork DSH web search card", () => {
  // The card's whole surface is one module the Host evaluates. A throw at load
  // removes it with nothing but a loader line in a console no user reads, and
  // this file is the only thing that evaluates that module at all: it is outside
  // the ESLint glob and outside the tsconfig `include`.
  test("registers one card, keyed to the namespace its plugin serves", () => {
    const { definition, plugin, registrations } = cardOf()

    expect(definition.id).toBe("@pawwork/dsh-web-search")
    expect(plugin.inject).toEqual(["slots", "locale", "connection", "remote", "settingsScope"])
    expect(registrations).toEqual([
      {
        name: "settings.plugin.item",
        key: "pawwork-web-search",
        locale: "pawwork-web-search",
        inject: expect.any(Function),
      },
    ])
  })

  // Nothing else in the app is a native `<select>`, and a portalled menu is one
  // the keyboard cannot reach: the primitive moves no focus into the portal and
  // restores none on close.
  test("the engine picker is an in-flow Menu, not a native select", () => {
    const { card, injected } = cardOf()

    const tree = render(card, injected)
    const menu = visit(tree).find((element) => element.type === "Menu")

    expect(visit(tree).some((element) => element.type === "select")).toBe(false)
    expect(menu?.props.portal).toBe(false)
    expect((menu?.props.items as Array<{ id: string }>).map((item) => item.id)).toEqual(["exa", "deepseek"])
    expect(menu?.props.selectedId).toBe("exa")
  })

  // An API key means nothing apart from the engine it authenticates, and a key
  // the card is not showing is one nobody can review before it is written. This
  // went wrong twice: first `save` wrote every staged key to whichever reference
  // the engine held at write time, then it wrote the abandoned draft to that
  // draft's own vendor. Both are the same defect — the card could stage more than
  // it displayed — so what this pins is the invariant, not either symptom: a save
  // writes what is on screen and nothing else.
  test("a save writes only the key the card is showing", async () => {
    const { credentials, injected } = cardOf()

    injected.editKey("exa-secret")
    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    await injected.save()

    expect(credentials.set).toHaveBeenCalledTimes(1)
    expect(credentials.set).toHaveBeenCalledWith({ ref: "DEEPSEEK_API_KEY", value: "deepseek-secret" })
  })

  test("changing the engine drops the key staged under the old one", async () => {
    const { credentials, injected } = cardOf()

    injected.editKey("exa-secret")
    injected.selectBackend("deepseek")
    expect(stateOf(injected).keyText).toBe("")

    injected.selectBackend("exa")
    expect(stateOf(injected).keyText).toBe("")

    await injected.save()
    expect(credentials.set).not.toHaveBeenCalled()
  })

  // The Save button and the writes have to agree on what counts as a change. They
  // did not: the button asked whether any draft held characters, `save` asked
  // whether any held characters after trimming, so a stray space left the button
  // lit on a save that would never write anything and never clear the draft.
  test("a whitespace-only key is not something to save", async () => {
    const { credentials, injected } = cardOf()

    injected.editKey("   ")

    expect(stateOf(injected).dirty).toBe(false)
    await injected.save()
    expect(credentials.set).not.toHaveBeenCalled()
    expect(stateOf(injected).saving).toBe(false)
  })

  // Nor is an engine the deployment already runs. Leaving the picker and coming
  // back is how a user reads their options, and it left the card claiming an
  // unsaved change with a Save that would write the value already in force.
  test("selecting the engine already in force is not something to save", async () => {
    const { credentials, injected } = cardOf()

    injected.selectBackend("deepseek")
    expect(stateOf(injected).dirty).toBe(true)

    injected.selectBackend("exa")
    expect(stateOf(injected).dirty).toBe(false)

    await injected.save()
    expect(credentials.set).not.toHaveBeenCalled()
  })

  // A write that threw used to escape `save` before it could clear `saving`,
  // leaving both buttons disabled for the rest of the session with the drafts
  // trapped behind them.
  test("a throwing write leaves the card usable", async () => {
    const { injected } = cardOf({
      set: async () => {
        throw new Error("read-only deployment")
      },
    })

    injected.selectBackend("deepseek")
    await injected.save()

    const state = stateOf(injected)
    expect(state.saving).toBe(false)
    expect(state.failed).toBe(true)
    expect(state.backend).toBe("deepseek")
  })

  // The deployment answers in the response envelope as well as by throwing, and
  // `configured` cannot stand in for either: it is already true whenever a key
  // was set before, so a rejected rotation read as a successful one — the field
  // cleared, no error, and the old key still in force.
  test("a rejected credential write is a failure, not a silent success", async () => {
    const { injected } = cardOf({
      describe: { result: { ok: true, value: { credentials: { EXA_API_KEY: { configured: true, writable: true } } } } },
      setCredential: async () => ({ result: { ok: false } }),
    })

    injected.editKey("rotated-key")
    await injected.save()

    const state = stateOf(injected)
    expect(state.failed).toBe(true)
    expect(state.keyText).toBe("rotated-key")
  })

  // The two writes settle independently, so a single "these values were not
  // accepted" can be false about one of them — and when the engine landed and
  // the key did not, it tells the user nothing changed while the deployment has
  // already switched engines.
  test("a partial failure names the field that did not land", async () => {
    const { card, injected } = cardOf({ setCredential: async () => ({ result: { ok: false } }) })

    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    await injected.save()

    expect(stateOf(injected).failedFields).toEqual(["key"])
    const text = visit(render(card, injected)).flatMap((element) => element.props.children as unknown[])
    expect(text).toContain("saveFailedKey")
  })

  test("discard drops every engine's staged key", () => {
    const { injected } = cardOf()

    injected.editKey("exa-secret")
    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    expect(stateOf(injected).dirty).toBe(true)

    injected.discard()

    expect(stateOf(injected).dirty).toBe(false)
    expect(stateOf(injected).keyText).toBe("")
  })

  // Recording a failure and announcing it are one step. `resetBackend` clears the
  // control before awaiting its write — so the user sees the reset take — and a
  // failure that only landed in the state left the card claiming success until
  // some later, unrelated edit published it and blamed that edit instead.
  test("a reset the deployment refuses is reported when it fails", async () => {
    const { injected } = cardOf({
      section: { value: { backend: "deepseek" }, user: { backend: "deepseek" } },
      unset: async () => {
        throw new Error("read-only deployment")
      },
    })

    await injected.resetBackend()

    expect(stateOf(injected).failed).toBe(true)
    expect(stateOf(injected).failedFields).toEqual(["backend"])
  })

  // The Host half falls back to the default reference for a blank one; a card
  // that did not would report a key as configured while the search resolved a
  // reference holding nothing.
  test("a blank credential reference falls back the way the Host half does", async () => {
    const { credentials, injected } = cardOf({ section: { value: { backend: "exa", exaApiKeyEnv: "   " } } })

    injected.editKey("exa-secret")
    await injected.save()

    expect(credentials.set).toHaveBeenCalledWith({ ref: "EXA_API_KEY", value: "exa-secret" })
  })
})
