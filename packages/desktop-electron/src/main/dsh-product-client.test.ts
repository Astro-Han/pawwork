import { readFileSync } from "node:fs"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { resolve } from "node:path"
import { describe, expect, vi, test } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const productRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/product")

describe("PawWork DSH client product layer", () => {
  function loadPlugin(timers: Array<() => void>, delays: number[] = []) {
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document: {
        title: "DeepSeek Harness",
        documentElement: { lang: "zh-CN" },
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: "" }),
        head: { appendChild: () => {} },
      },
      setTimeout: (callback: () => void, delay: number) => {
        timers.push(callback)
        delays.push(delay)
        return timers.length
      },
      clearTimeout: () => {},
    })
    return definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
  }

  function applyWatcher({ call, refresh, sessionIds = () => [], dispose }: {
    call: () => Promise<unknown>
    refresh: () => Promise<void>
    sessionIds?: () => string[]
    dispose?: (setup: () => unknown) => void
  }) {
    return {
      connection: { rpc: { call } },
      effect: dispose ?? ((fn: () => unknown) => fn()),
      sessions: { list: { getSnapshot: () => ({ ids: sessionIds() }) }, refresh },
      slots: { inject: (_name: string, register: () => void) => register(), register: () => {} },
    }
  }

  test("is a packaged DSH web plugin", () => {
    const productPackage = JSON.parse(readFileSync(resolve(productRoot, "package.json"), "utf8"))

    expect(productPackage.name).toBe("@pawwork/dsh-product")
    expect(productPackage.exports["./client"].default).toBe("./lib/client.js")
    expect(productPackage.dsh.client).toEqual({
      inject: ["@deepseek-ai/dsh-client-runtime"],
      platform: "web",
    })
  })

  test("owns the public brand slots and replaces the DSH welcome notice", () => {
    const ready = vi.fn(() => {})
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }

    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      window: { pawworkLifecycle: { ready } },
    })
    expect(definition.id).toBe("@pawwork/dsh-product")

    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const useEffect = (effect: () => void) => effect()
    const useRef = <T>(value: T) => ({ current: value })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement, useEffect, useRef }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{
      options: { id?: string; name?: string; priority?: number }
      component: (props: unknown) => unknown
    }> = []
    const ctx = {
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { phase: "done" } })) } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; name?: string; priority?: number }, component: (props: unknown) => unknown) => {
          registrations.push({ options, component })
        },
      },
    }

    plugin.apply(ctx)
    expect(plugin.inject).toEqual(["slots", "connection", "sessions"])
    const welcome = registrations.find((entry) => entry.options.id === "welcome-notice")
    expect(welcome).toBeDefined()
    expect(welcome!.options.priority).toBe(-1)
    const complete = vi.fn(() => {})
    welcome!.component({ complete })
    expect(complete).toHaveBeenCalledTimes(1)

    const brandEntries = registrations.filter((entry) => entry.options.name?.includes("brand"))
    expect(brandEntries.map((entry) => entry.options.name)).toEqual([
      "sidebar.brand.mark",
      "sidebar.brand.name",
      "conversation.hero.brand.mark",
    ])
    expect(brandEntries.every((entry) => entry.options.priority === -100)).toBe(true)
    const sidebarMark = brandEntries[0].component({ size: 24 }) as { type: string; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe("svg")
    expect(sidebarMark.props).toMatchObject({ viewBox: "0 0 64 64", width: 24, height: 24 })
    expect(ready).toHaveBeenCalledTimes(1)
    expect(brandEntries[1].component({})).toBe("爪印")
    const heroMark = brandEntries[2].component({ size: 34 }) as { type: string; props: Record<string, unknown> }
    expect(heroMark.type).toBe("svg")
    expect(heroMark.props).toMatchObject({ viewBox: "0 0 64 64", width: 34, height: 34 })
    expect(ready).toHaveBeenCalledTimes(1)
  })

  test("mounts the drag strip that reserves the native window chrome", () => {
    const appended: Array<{ className: string }> = []
    const style = { dataset: {} as Record<string, string>, textContent: "" }
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN", dataset: {} },
      readyState: "complete",
      querySelector: () => null,
      createElement: (tag: string) => (tag === "style" ? style : { className: "" }),
      head: { appendChild: () => {} },
      body: { appendChild: (node: { className: string }) => appended.push(node) },
    }

    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), { document, navigator: { platform: "MacIntel" } })
    definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })

    // The strip must be a real element: -webkit-app-region does nothing on pseudo-elements.
    expect(appended.map((node) => node.className)).toEqual(["pawwork-titlebar"])
    expect(style.textContent).toContain("-webkit-app-region: drag")
    expect(style.textContent).toContain("padding-top: var(--pawwork-titlebar-height, 0px)")
    expect(style.textContent).toContain('[class*="_banner_"] { top: var(--pawwork-titlebar-height, 0px); }')
    expect(style.textContent).toContain("var(--pawwork-titlebar-host-height, env(titlebar-area-height, 0px))")
    expect(style.textContent).not.toMatch(/--pawwork-titlebar-height:\s*\d/)
  })


  test("adds selected file paths through the public composer input slot", async () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const pick = vi.fn(async () => ({
      status: "selected",
      paths: ["/tmp/notes.md"],
    }))

    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      window: { pawworkFiles: { pick } },
    })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    let fileAction: ((props: unknown) => { props: Record<string, unknown> }) | undefined
    const ctx = {
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { phase: "done" } })) } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string }, component: typeof fileAction) => {
          if (options.id === "pawwork-files") fileAction = component
        },
      },
    }

    plugin.apply(ctx)
    expect(fileAction).toBeDefined()
    const setDraft = vi.fn(() => {})
    const button = fileAction!({
      input: { draft: "请总结", phase: "plain" },
      inputActions: { setDraft },
    })
    await (button.props.onClick as () => Promise<void>)()

    expect(pick).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith('请总结\n\n文件：\n- "/tmp/notes.md"')
  })

  // An old backend without this channel and a host restart are both transient, so a transport
  // failure must not be read as completion.
  test("backs off repeated transport failures and recovers without giving up", async () => {
    const timers: Array<() => void> = []
    const delays: number[] = []
    const plugin = loadPlugin(timers, delays)
    let failuresLeft = 20
    const call = vi.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error("status channel unavailable")
      }
      return { ok: true, value: { phase: "done", sessionId: "pawwork-v1-session" } }
    })
    const visibleSessionIds: string[] = []
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 2) visibleSessionIds.push("pawwork-v1-session")
    })
    plugin.apply(applyWatcher({ call, refresh, sessionIds: () => visibleSessionIds }))

    await new Promise((resolve) => setImmediate(resolve))
    for (let retry = 0; retry < 20; retry += 1) {
      timers.shift()!()
      await new Promise((resolve) => setImmediate(resolve))
    }

    expect(call).toHaveBeenCalledTimes(21)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(0)
    expect(delays.slice(0, 6)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(delays.at(-1)).toBe(30_000)
  })

  test("retries completion until the imported session is installed in the list", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    const visibleSessionIds: string[] = []
    const call = vi.fn(async () => ({
      ok: true,
      value: { phase: "done", sessionId: "pawwork-v1-session" },
    }))
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 4) visibleSessionIds.push("pawwork-v1-session")
    })
    plugin.apply(applyWatcher({ call, refresh, sessionIds: () => visibleSessionIds }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(1)

    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(timers).toHaveLength(0)
  })

  test("waits for v1 import completion before issuing a fresh authoritative read", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    const refresh = vi.fn()
    let firstInFlight: () => void = () => {}
    const visibleSessionIds: string[] = []
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { firstInFlight = resolve }))
    refresh.mockImplementation(async () => { visibleSessionIds.push("pawwork-v1-session") })
    const remainingPhases = ["running", "done"]
    const call = vi.fn(async () => ({
      ok: true,
      value: { phase: remainingPhases.shift(), sessionId: "pawwork-v1-session" },
    }))
    plugin.apply(applyWatcher({ call, refresh, sessionIds: () => visibleSessionIds }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("/pawwork-import-v1", "status", {})
    expect(refresh).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)

    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledTimes(1)
    firstInFlight()
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(0)
  })

  test("does not start the authoritative read after disposal", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    let finishFirstRefresh: () => void = () => {}
    const refresh = vi.fn(() => new Promise<void>((resolve) => { finishFirstRefresh = resolve }))
    const call = vi.fn(async () => ({
      ok: true,
      value: { phase: "done", sessionId: "pawwork-v1-session" },
    }))
    let dispose: (() => void) | undefined
    plugin.apply(applyWatcher({ call, refresh, dispose: (fn) => { dispose = fn() as () => void } }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
    dispose!()
    finishFirstRefresh()
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(0)
  })

  test("retries a malformed success response instead of dereferencing it", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    const responses = [
      { ok: true, value: undefined },
      { ok: true, value: { phase: "done", sessionId: "pawwork-v1-session" } },
    ]
    const call = vi.fn(async () => responses.shift())
    const refresh = vi.fn(async () => {})
    plugin.apply(applyWatcher({ call, refresh, sessionIds: () => ["pawwork-v1-session"] }))

    await new Promise((resolve) => setImmediate(resolve))
    expect(timers).toHaveLength(1)
    expect(refresh).not.toHaveBeenCalled()
    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(0)
  })

  test("stops polling when the client plugin is disposed", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    const call = vi.fn(async () => ({ ok: true, value: { phase: "running" } }))
    const refresh = vi.fn(async () => {})
    let dispose: (() => void) | undefined
    plugin.apply(applyWatcher({ call, refresh, dispose: (fn) => { dispose = fn() as () => void } }))
    await new Promise((resolve) => setImmediate(resolve))
    expect(timers).toHaveLength(1)
    expect(dispose).toBeTypeOf("function")
    dispose!()
    const pending = timers.splice(0)
    for (const fire of pending) fire()
    expect(call).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
  })

  test("does not refresh when disposed during an in-flight status call", async () => {
    const timers: Array<() => void> = []
    const plugin = loadPlugin(timers)
    let resolveStatus: (result: unknown) => void = () => {}
    const call = vi.fn(() => new Promise((resolve) => { resolveStatus = resolve }))
    const refresh = vi.fn(async () => {})
    let dispose: (() => void) | undefined
    plugin.apply(applyWatcher({ call, refresh, dispose: (fn) => { dispose = fn() as () => void } }))

    dispose!()
    resolveStatus({ ok: true, value: { phase: "done", sessionId: "pawwork-v1-session" } })
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).not.toHaveBeenCalled()
    expect(timers).toHaveLength(0)
  })
})
