import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { dshRemoteContract, fakeDshRemote, type RemoteAnswer } from "./dsh-remote-contract.testing"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const clientEntry = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/web-search/lib/client.js")

// The credentials namespace as the installed DSH serves it.
const CREDENTIALS = await dshRemoteContract("@deepseek-ai/dsh-api-settings-controller", "credentials")

/** The answer a deployment gives for a value it read and would not keep. */
function refusal(): RemoteAnswer {
  return { ok: false, error: { code: "credential/rejected", message: "the deployment refused the value" } }
}

/** Let the card's own fire-and-forget reads settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  // The host console stands in for the page's, so the card's logs reach the test.
  const definition = loadDshClientModule(clientEntry, { console, document: fakeDocument() })
  return {
    definition,
    plugin: definition.factory((module: string) => {
      if (module === "react") return { createElement, useState: <T>(value: T) => [value === false ? true : value, () => {}] }
      if (module === "@deepseek-ai/dsh-client-ui-primitives") {
        return { IconChevronDownOutline14: "IconChevronDown", Menu: "Menu" }
      }
      if (module === "@deepseek-ai/dsh-client-store") return { createSnapshotStore: fakeStore }
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
  /** Answers `credentials.describe`, the way the deployment would. */
  describe?: () => RemoteAnswer | Promise<RemoteAnswer>
  /** Answers `credentials.set`, the way the deployment would. */
  setCredential?: () => RemoteAnswer | Promise<RemoteAnswer>
  set?: () => Promise<unknown>
  unset?: () => Promise<unknown>
  unsetIgnored?: boolean
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
    unset: vi.fn(async (key: string) => {
      if (options.unset !== undefined) await options.unset()
      // A Host that resolves the call without removing the override is the case
      // the read-back exists for, so the fake can be told to behave that way.
      if (options.unsetIgnored === true) return
      const user = { ...(snapshot.user as Record<string, unknown>) }
      delete user[key]
      snapshot.user = Object.keys(user).length > 0 ? user : undefined
      snapshot.value = { ...(snapshot.value as object), [key]: (snapshot.base as Record<string, unknown>)?.[key] }
    }),
  }
  // Spied, not replaced: the double's parsing is what refuses a bad call.
  const namespace = fakeDshRemote(CREDENTIALS, {
    describe: async () => options.describe?.() ?? { ok: true, value: {} },
    set: async () => options.setCredential?.() ?? { ok: true, value: undefined },
  })
  const credentials = { describe: vi.fn(namespace.describe), set: vi.fn(namespace.set) }
  plugin.apply({
    // The context hands over exactly what the plugin declares, so a card that
    // reaches for anything else fails here.
    get: (service: string) => {
      throw new Error(`the card reached for a service it does not declare: ${service}`)
    },
    effect: (run: () => unknown) => run(),
    locale: { register: () => () => {} },
    remote: { $on: () => () => {}, credentials },
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

function textOf(card: (props: Record<string, unknown>) => unknown, injected: CardActions) {
  return visit(render(card, injected)).flatMap((element) => element.props.children as unknown[])
}

describe("PawWork DSH web search card", () => {
  // The card's whole surface is one module the Host evaluates, and a throw at
  // load removes it with nothing but a loader line in a console no user reads.
  // This file is the only thing that evaluates it; lint parses it but does not
  // run it, and it is outside the tsconfig `include`.
  test("registers one card, keyed to the namespace its plugin serves", () => {
    const { definition, plugin, registrations } = cardOf()

    expect(definition.id).toBe("@pawwork/dsh-web-search")
    expect(plugin.inject).toEqual(["slots", "locale", "remote", "remote.credentials", "settingsScope"])
    expect(registrations).toEqual([
      {
        name: "settings.plugin.item",
        key: "pawwork-web-search",
        locale: "pawwork-web-search",
        inject: expect.any(Function),
      },
    ])
  })

  // Every contract assertion in this file rests on the double refusing what the
  // runtime refuses: a card sending the wrong shape has to fail here, or the
  // suite passes while the card is wrong.
  test("the double refuses a call the deployment would", async () => {
    const namespace = fakeDshRemote(CREDENTIALS, { set: async () => ({ ok: true, value: undefined }) })

    await expect(namespace.set("EXA_API_KEY")).rejects.toThrow(/expected 2 argument/)
    await expect(namespace.set("EXA_API_KEY", "value", "extra")).rejects.toThrow(/expected 2 argument/)
    await expect(namespace.set("EXA_API_KEY", 7)).rejects.toThrow(/rejected/)
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
    expect(credentials.set).toHaveBeenCalledWith("DEEPSEEK_API_KEY", "deepseek-secret")
  })

  // A staged key is invisible and unwritable under any engine but the one it was
  // typed under. It is not destroyed either: reading the card must not be what
  // discards a secret, or a save that races an engine change elsewhere loses the
  // user's typing while telling them it was kept for them to correct.
  test("a key staged under one engine is neither shown nor written under another", async () => {
    const { credentials, injected } = cardOf()

    injected.editKey("exa-secret")
    injected.selectBackend("deepseek")

    expect(stateOf(injected).keyText).toBe("")
    await injected.save()
    expect(credentials.set).not.toHaveBeenCalled()

    injected.selectBackend("exa")
    expect(stateOf(injected).keyText).toBe("exa-secret")

    await injected.save()
    expect(credentials.set).toHaveBeenCalledWith("EXA_API_KEY", "exa-secret")
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
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { injected } = cardOf({
        set: async () => {
          throw new Error("read-only deployment")
        },
      })

      injected.selectBackend("deepseek")
      await injected.save()

      const state = stateOf(injected)
      expect(state.saving).toBe(false)
      expect(state.failure).toEqual({ field: "backend", kind: "broken" })
      expect(state.backend).toBe("deepseek")
    } finally {
      logged.mockRestore()
    }
  })

  test("the card asks about the reference the section names", async () => {
    const { credentials, injected } = cardOf({
      describe: () => ({ ok: true, value: { EXA_API_KEY: { configured: true, writable: true } } }),
    })
    await settle()

    expect(credentials.describe).toHaveBeenCalledWith(["EXA_API_KEY"])
    expect(stateOf(injected)).toMatchObject({ keyConfigured: true })

    injected.selectBackend("deepseek")
    await settle()

    // The answer is keyed by the reference that was asked about.
    expect(credentials.describe).toHaveBeenLastCalledWith(["DEEPSEEK_API_KEY"])
    expect(stateOf(injected)).toMatchObject({ keyConfigured: false })
  })

  test("an answer a newer read has replaced does not overwrite it", async () => {
    const answers: Array<(answer: RemoteAnswer) => void> = []
    const { injected } = cardOf({
      describe: () => new Promise<RemoteAnswer>((resolve) => { answers.push(resolve) }),
    })
    await settle()

    injected.selectBackend("deepseek")
    await settle()
    injected.selectBackend("exa")
    await settle()
    expect(answers).toHaveLength(3)

    answers[2]({ ok: true, value: { EXA_API_KEY: { configured: true, writable: false } } })
    await settle()
    expect(stateOf(injected)).toMatchObject({ keyConfigured: true, keyWritable: false })

    answers[0]({ ok: true, value: { EXA_API_KEY: { configured: false, writable: true } } })
    await settle()

    expect(stateOf(injected)).toMatchObject({ keyConfigured: true, keyWritable: false })
  })

  test("a rejected credential write is a failure, not a silent success", async () => {
    const { injected } = cardOf({
      describe: () => ({ ok: true, value: { EXA_API_KEY: { configured: true, writable: true } } }),
      setCredential: () => refusal(),
    })

    injected.editKey("rotated-key")
    await injected.save()

    const state = stateOf(injected)
    expect(state.failure).toEqual({ field: "key", kind: "refused" })
    expect(state.keyText).toBe("rotated-key")
  })

  test("a failure names the field that did not land", async () => {
    const { card, injected } = cardOf({ setCredential: () => refusal() })

    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    await injected.save()

    expect(stateOf(injected).failure).toEqual({ field: "key", kind: "refused" })
    expect(textOf(card, injected)).toContain("saveFailedKey")
  })

  // A refusal and a call that never arrived need different copy: the first is the
  // user's to correct, the second is not.
  test("a write that never reached an authority is this app's fault, not the input's", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { card, injected } = cardOf({
        setCredential: () => ({ ok: false, error: { code: "gateway/internal", message: "no active Connection" } }),
      })

      injected.editKey("exa-secret")
      await injected.save()

      expect(stateOf(injected).failure).toEqual({ field: "key", kind: "broken" })
      expect(textOf(card, injected)).toContain("saveFailedApp")
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
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

  // Reset stages; it does not write. A second writer would race `save` over the
  // same section and the same failure, and `saving` cannot serialize what it
  // does not own.
  test("a reset stages the default and writes nothing until saved", async () => {
    const { scope, injected } = cardOf({
      section: { base: { backend: "exa" }, value: { backend: "deepseek" }, user: { backend: "deepseek" } },
    })

    injected.resetBackend()

    expect(scope.unset).not.toHaveBeenCalled()
    expect(stateOf(injected)).toMatchObject({ backend: "exa", dirty: true, backendOverridden: false })

    await injected.save()

    expect(scope.unset).toHaveBeenCalledWith("backend")
    expect(stateOf(injected)).toMatchObject({ backend: "exa", dirty: false })
    expect(stateOf(injected).failure).toBeUndefined()
  })

  // The Host's validators own constraints no schema expresses, so a call it
  // resolves is not a value it kept. Predicting the outcome of the engine write
  // and reading back the reset would let a pinned deployment answer a reset with
  // "saved", the card clear its draft, and the engine quietly stay where it was.
  test("a reset the deployment did not apply is reported, not assumed", async () => {
    const { injected } = cardOf({
      section: { base: { backend: "exa" }, value: { backend: "deepseek" }, user: { backend: "deepseek" } },
      unsetIgnored: true,
    })

    injected.resetBackend()
    await injected.save()

    expect(stateOf(injected)).toMatchObject({ dirty: true })
    expect(stateOf(injected).failure).toEqual({ field: "backend", kind: "broken" })
  })

  // Choosing the engine already on screen is not an edit. Recorded as one, it
  // turned a staged reset into an explicit override of the same value: the user
  // pressed "restore default", glanced at the picker, and pinned themselves to
  // the engine they had just stopped pinning.
  test("re-picking the engine already shown leaves a staged reset staged", async () => {
    const { scope, injected } = cardOf({
      section: { base: { backend: "exa" }, value: { backend: "deepseek" }, user: { backend: "deepseek" } },
    })

    injected.resetBackend()
    injected.selectBackend("exa")
    await injected.save()

    expect(scope.unset).toHaveBeenCalledWith("backend")
    expect(scope.set).not.toHaveBeenCalled()
  })

  // The staged reset and a staged key are one save, and the key goes first: the
  // two stores cannot commit together, so the engine never runs a moment without
  // the credential it was chosen for, and an engine write that fails still
  // leaves the key under the vendor the user was looking at.
  test("a save writes the key before the engine it was typed under", async () => {
    const order: string[] = []
    const { credentials, scope, injected } = cardOf({
      setCredential: () => {
        order.push("key")
        return { ok: true, value: undefined }
      },
    })
    scope.set.mockImplementation(async () => {
      order.push("backend")
    })

    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    await injected.save()

    expect(order).toEqual(["key", "backend"])
    expect(credentials.set).toHaveBeenCalledWith("DEEPSEEK_API_KEY", "deepseek-secret")
  })

  // A write that failed without leaving a draft behind used to render a message
  // with every control that could clear it disabled, and the only way out was to
  // type into the key field.
  test("a failure can be dismissed even when it left no draft", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { injected } = cardOf({
        section: { base: { backend: "exa" }, value: { backend: "deepseek" }, user: { backend: "deepseek" } },
        unset: async () => {
          throw new Error("read-only deployment")
        },
      })

      injected.resetBackend()
      await injected.save()

      expect(stateOf(injected).failure).toEqual({ field: "backend", kind: "broken" })

      injected.discard()

      expect(stateOf(injected)).toMatchObject({ dirty: false, backend: "deepseek" })
      expect(stateOf(injected).failure).toBeUndefined()
    } finally {
      logged.mockRestore()
    }
  })

  // A reference the two halves read differently has the card describing and
  // writing one name while the search resolves another, so the card applies the
  // Host's whole grammar and not just its blank check.
  test("an unresolvable credential reference falls back the way the Host half does", async () => {
    for (const ref of ["", "   ", "my-key", "1KEY", "EXA.API.KEY"]) {
      const { credentials, injected } = cardOf({ section: { value: { backend: "exa", exaApiKeyEnv: ref } } })

      injected.editKey("exa-secret")
      await injected.save()

      expect(credentials.set).toHaveBeenCalledWith("EXA_API_KEY", "exa-secret")
    }
  })

  // The key is written first so the engine never runs a moment without the
  // credential it was chosen for. Carrying on past a refused key produced that
  // exact state: DeepSeek needs one, so the deployment moved to an engine with
  // nothing stored and every search failed, while the footer named only the key.
  test("a refused key does not move the user onto the engine that needed it", async () => {
    const { credentials, scope, injected } = cardOf({
      setCredential: () => refusal(),
    })

    injected.selectBackend("deepseek")
    injected.editKey("deepseek-secret")
    await injected.save()

    expect(credentials.set).toHaveBeenCalledTimes(1)
    expect(scope.set).not.toHaveBeenCalled()
    expect(stateOf(injected)).toMatchObject({
      backend: "deepseek",
      dirty: true,
      failure: { field: "key", kind: "refused" },
      keyText: "deepseek-secret",
    })
  })

  // A draft that would write nothing is still a draft the user can see, and
  // Discard is the only control that clears it: asking `dirty` greyed out both
  // buttons over a field with a space in it, leaving backspace as the way out.
  test("a key that would write nothing can still be discarded", async () => {
    const { card, injected } = cardOf()

    injected.editKey("   ")

    expect(stateOf(injected)).toMatchObject({ dirty: false, staged: true })
    const discard = visit(render(card, injected)).find((node) => node.props.className === "pawwork-websearch-discard")
    expect(discard?.props.disabled).toBe(false)

    injected.discard()

    expect(stateOf(injected).keyText).toBe("")
  })
})
