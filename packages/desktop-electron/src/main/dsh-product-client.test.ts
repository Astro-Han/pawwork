import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { resolve } from "node:path"
import { describe, expect, vi, test } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const productRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/product")

type Element = { type: unknown; props: Record<string, unknown> }

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
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
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

  function loadProductCss() {
    const appended: Array<{ className: string }> = []
    const style = { dataset: {} as Record<string, string>, textContent: "" }
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      readyState: "complete",
      querySelector: () => null,
      createElement: (tag: string) => (tag === "style" ? style : { className: "" }),
      head: { appendChild: () => {} },
      body: { appendChild: (node: { className: string }) => appended.push(node) },
    }
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), { document })
    definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    return { appended, css: style.textContent }
  }

  test("is a packaged DSH web plugin", () => {
    const productPackage = JSON.parse(readFileSync(resolve(productRoot, "package.json"), "utf8"))

    expect(productPackage.name).toBe("@pawwork/dsh-product")
    expect(productPackage.exports["./client"].default).toBe("./lib/client.js")
    // 0.1.2-alpha.2 split `dsh-client-runtime` into the packages that own each
    // client service, so the manifest now names one per service `client.js`
    // reads: slots, connection, sessions, layout — in that order.
    expect(productPackage.dsh.client).toEqual({
      inject: [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-ui-layout",
      ],
      platform: "web",
    })
  })

  test("registers one community-market connector tab in DSH Plugins settings", () => {
    const document = {
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      window: { pawworkCommunityMarket: { status: vi.fn(), enable: vi.fn(), restart: vi.fn() } },
    })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{ id?: string; label?: () => string; name?: string; order?: number }> = []
    plugin.apply({
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { phase: "done" } })) } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; label?: () => string; name?: string; order?: number }) => {
          registrations.push(options)
          return () => {}
        },
      },
    })

    const management = registrations.find((entry) => entry.id === "pawwork-community-market")
    expect(management).toMatchObject({ name: "settings.plugins.tab", order: 20 })
    expect(management?.label?.()).toBe("社区市场")
    document.documentElement.lang = "en"
    expect(management?.label?.()).toBe("Community market")
  })

  test("enables the pinned community market from a trust-explicit Settings card", async () => {
    const enable = vi.fn(async () => ({ enabled: true, restartRequired: true, version: "1.21.0" }))
    const document = {
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      window: { pawworkCommunityMarket: { status: vi.fn(), enable, restart: vi.fn() } },
    })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
      const nextProps = { ...props, children }
      return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
    }
    const states: unknown[] = [{ status: "ready", market: { enabled: false, restartRequired: false, version: null }, error: "" }]
    let stateIndex = 0
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
          useState: (initial: unknown) => {
            const value = stateIndex < states.length ? states[stateIndex] : initial
            stateIndex += 1
            return [value, vi.fn()]
          },
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          Button: (props: Record<string, unknown>) => ({ type: "button", props }),
          IconPanelLeftOutline16: () => null,
        }
      }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    let managementTab: ((props: unknown) => unknown) | undefined
    plugin.apply({
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { phase: "done" } })) } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string }, component: typeof managementTab) => {
          if (options.id === "pawwork-community-market") managementTab = component
          return () => {}
        },
      },
    })

    const tree = managementTab!({})
    expect(textOf(tree)).toContain("社区市场及其中插件均由第三方维护，并会以爪印的权限运行。")
    const button = visit(tree).find((element) => element.type === "button")!
    await (button.props.onClick as () => Promise<void>)()
    expect(enable).toHaveBeenCalledWith()
  })

  test("pins the public DSH layout contracts consumed by the window chrome", () => {
    const requireFromTest = createRequire(import.meta.url)
    const dshPackage = requireFromTest.resolve("@deepseek-ai/dsh/package.json")
    const requireFromDsh = createRequire(dshPackage)
    const webAppPackage = requireFromDsh.resolve("@deepseek-ai/dsh-web-app/package.json")
    const requireFromWebApp = createRequire(webAppPackage)
    const layoutPackage = requireFromWebApp.resolve("@deepseek-ai/dsh-client-ui-layout/package.json")
    const layoutRoot = resolve(layoutPackage, "..")
    const client = readFileSync(resolve(layoutRoot, "lib/client.js"), "utf8")
    const columnTypes = readFileSync(resolve(layoutRoot, "lib/types/client/columns.d.ts"), "utf8")
    const serviceTypes = readFileSync(resolve(layoutRoot, "lib/types/client/service.d.ts"), "utf8")
    const { css } = loadProductCss()
    const collapsedWidth = columnTypes.match(/SIDEBAR_COLLAPSED = (\d+)/)?.[1]

    expect(client).toContain('renderSlot("shell.overlay", {})')
    expect(client).toContain('ctx.reflect.provide("layout", layout)')
    expect(client).toContain("border-right:.5px solid var(--dsw-alias-border-l3)")
    expect(serviceTypes).toMatch(/interface ILayout[\s\S]*toggleSidebar\(\): void;/)
    expect(collapsedWidth).toBeDefined()
    expect(css).toContain(`--pawwork-dsh-collapsed-sidebar-width: ${collapsedWidth}px;`)
    expect(css).toMatch(/calc\(var\(--pawwork-titlebar-inset-left\) \+ 44px - var\(--pawwork-dsh-collapsed-sidebar-width\)\)/)
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
    expect(plugin.inject).toEqual(["slots", "connection", "sessions", "layout"])
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

  test("owns one shell overlay sidebar toggle through the public layout service", () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), { document })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const PanelLeftIcon = () => null
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement, useEffect: () => {}, useRef: () => ({ current: null }) }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: PanelLeftIcon }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{
      options: { id?: string; inject?: () => unknown; name?: string }
      component: (props: unknown) => unknown
    }> = []
    const toggleSidebar = vi.fn()
    const ctx = {
      connection: { rpc: { call: vi.fn(async () => ({ ok: true, value: { phase: "done" } })) } },
      effect: (fn: () => unknown) => fn(),
      layout: { toggleSidebar },
      sessions: { refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; inject?: () => unknown; name?: string }, component: (props: unknown) => unknown) => {
          registrations.push({ options, component })
        },
      },
    }

    plugin.apply(ctx)

    expect(plugin.inject).toEqual(["slots", "connection", "sessions", "layout"])
    const overlay = registrations.filter((entry) => entry.options.name === "shell.overlay")
    expect(overlay.map((entry) => entry.options.id)).toEqual(["pawwork-window-chrome", "pawwork-v1-import"])
    const chrome = overlay[0]
    const tree = chrome.component(chrome.options.inject?.()) as {
      props: { children: Array<{ type: unknown; props: Record<string, unknown> }> }
    }
    const button = tree.props.children[1]
    expect(button.props).toMatchObject({
      "aria-label": "切换侧边栏",
      className: "pawwork-sidebar-toggle",
      title: "切换侧边栏",
      type: "button",
    })
    expect((button.props.children as Array<{ type: unknown }>)[0].type).toBe(PanelLeftIcon)
    ;(button.props.onClick as () => void)()
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  test("reserves only the native-control edges without pushing the whole shell down", () => {
    const { appended, css } = loadProductCss()

    // The real drag strip is owned by shell.overlay; the plugin must not append parallel DOM.
    expect(appended).toEqual([])
    expect(css).toContain("--pawwork-titlebar-inset-left: var(--pawwork-titlebar-host-inset-left, env(titlebar-area-x, 0px))")
    expect(css).toContain("--pawwork-titlebar-inset-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))")
    expect(css).toContain("var(--pawwork-titlebar-host-height, env(titlebar-area-height, 0px))")
    expect(css).toContain("--pawwork-titlebar-control-center-y")
    expect(css).not.toContain("#root { box-sizing: border-box; padding-top:")
    expect(css).not.toMatch(/--pawwork-titlebar-height:\s*\d/)
  })

  test("keeps the top background draggable while leaving its controls clickable", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/\.pawwork-window-drag-region\s*{[^}]*-webkit-app-region:\s*drag[^}]*pointer-events:\s*none/s)
    expect(css).toMatch(/\.pawwork-sidebar-toggle\s*{[^}]*-webkit-app-region:\s*no-drag[^}]*pointer-events:\s*auto/s)
  })

  test("does not restore universal control hover styling", () => {
    const { css } = loadProductCss()

    expect(css).not.toMatch(/:where\([^)]*button[^)]*\)[^{]*:hover\s*{[^}]*background(?:-color)?\s*:/s)
    expect(css).toMatch(/\.pawwork-file-action:hover\s*{[^}]*background\s*:/s)
  })

  test("gives inactive conversation tabs a local underline hover cue", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/\[data-slot="conversation\.session\.header"\] \[role="tab"\]\[aria-selected="false"\]:hover\s*{[^}]*color:\s*var\(--dsw-alias-label-primary\)/s)
    expect(css).toMatch(/\[data-slot="conversation\.session\.header"\] \[role="tab"\]\[aria-selected="false"\]:hover::after\s*{[^}]*background:\s*var\(--dsw-alias-label-caption\)/s)
    expect(css).not.toMatch(/\[data-slot="conversation\.session\.header"\] \[role="tab"\][^{]*:hover\s*{[^}]*background/s)
  })

  test("centers trajectory in a bounded wide data column", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/\[data-conversation-composer-overlay\]:has\(\[data-trajectory-scroll\]\)\s*{[^}]*align-self:\s*center/s)
    expect(css).toMatch(/\[data-conversation-composer-overlay\]:has\(\[data-trajectory-scroll\]\)\s*{[^}]*width:\s*calc\(100% - 48px\)[^}]*max-width:\s*1200px/s)
  })

  test("places session actions at the trailing edge of the title cluster", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/:has\(> \[data-slot="conversation\.session\.header\.actions"\]\)\s*{[^}]*margin-left:\s*auto/s)
  })

  test("lets the current session title use the space before header actions", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/\[data-slot="conversation\.session\.header"\] nav:has\(button:disabled\)\s*{[^}]*flex:\s*1/s)
    expect(css).toMatch(/\[data-slot="conversation\.session\.header"\] nav button:disabled\s*{[^}]*max-width:\s*100%/s)
  })

  test("hides both DSH sidebar controls while preserving their layout seat and ready mark", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/div:has\(> button \[data-slot="sidebar\.brand\.name"\]\) > button[^{]*{[^}]*visibility:\s*hidden/s)
    expect(css).toMatch(/div:has\(> button \[data-slot="sidebar\.brand\.mark"\]\):not\(:has\(\[data-slot="sidebar\.brand\.name"\]\)\) > button[^{]*{[^}]*visibility:\s*hidden/s)
    expect(css).not.toContain('[data-slot="sidebar.brand.mark"] { display: none; }')
  })

  test("fades DSH's sidebar border instead of drawing a second divider", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/\[data-sidebar-collapsed\][^{]*div:has\(> \[data-slot="sidebar"\]\)[^{]*{[^}]*border-right-color:\s*transparent/s)
    expect(css).not.toContain('div:has(> [data-slot="sidebar"])::after')
  })

  test("keeps app header controls to the left of the Windows caption buttons", () => {
    const { css } = loadProductCss()

    expect(css).toMatch(/--pawwork-session-column-safe-right:\s*max\([^;]*calc\(28px \+ var\(--pawwork-titlebar-inset-right/s)
    expect(css).toMatch(/\[data-slot="conversation\.session\.header"\] > header > :is\([^}]*{[^}]*width:\s*min\([^;]*var\(--pawwork-session-column-safe-right/s)
    expect(css).toMatch(/\[data-slot="details"\] > \* > :first-child\s*{[^}]*padding-right:\s*calc\(12px \+ var\(--pawwork-titlebar-inset-right/s)
    expect(css).toMatch(/body > \[class\*="_banner_"\]\s*{[^}]*top:\s*0[^}]*padding-right:\s*var\(--pawwork-titlebar-inset-right/s)
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

  // The import overlay is the only thing that tells an upgrading user why their
  // sessions are not there yet, so it is rendered through the real store the
  // watcher publishes into rather than against a hand-made state.
  async function renderImportOverlay(value: unknown) {
    const timers: Array<() => void> = []
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document: {
        title: "DeepSeek Harness",
        documentElement: { lang: "zh-CN" },
        querySelector: () => null,
        createElement: () => ({ dataset: {}, textContent: "" }),
        head: { appendChild: () => {} },
      },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => {},
    })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown => {
      const nextProps = { ...props, children }
      return typeof type === "function" ? type(nextProps) : { type, props: nextProps }
    }
    const plugin = definition.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: (effect: () => void) => { effect() },
          useRef: <T>(initial: T) => ({ current: initial }),
          useState: (initial: unknown) => [initial, vi.fn()],
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return { Button: (props: Record<string, unknown>) => ({ type: "button", props }), IconPanelLeftOutline16: () => null }
      }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const call = vi.fn(async () => ({ ok: true, value }))
    let overlay: (() => unknown) | undefined
    plugin.apply({
      connection: { rpc: { call } },
      effect: (fn: () => unknown) => fn(),
      layout: { toggleSidebar: vi.fn() },
      sessions: { list: { getSnapshot: () => ({ ids: [] }) }, refresh: vi.fn(async () => {}) },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; inject?: () => unknown }, component: (props: unknown) => unknown) => {
          if (options.id === "pawwork-v1-import") overlay = () => component(options.inject?.())
        },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    return { call, tree: overlay!(), timers }
  }

  test("keeps a standing strip up while the old PawWork still holds the v1 database", async () => {
    const { tree, timers } = await renderImportOverlay({ phase: "blocked" })

    expect(textOf(tree)).toContain("请先退出旧版爪印，导入会自动继续。")
    expect(visit(tree).some((element) => element.props.role === "status")).toBe(true)
    // Blocked is not an error state: the watcher keeps its steady cadence so the
    // strip disappears on its own once the user quits v1.
    expect(timers).toHaveLength(1)
  })

  test("reports the import result the host handed it", async () => {
    const { tree } = await renderImportOverlay({
      phase: "done",
      notice: { imported: 3, failed: 1, reasons: ["invalid JSON in message m1"], ledgerPath: "/home/import-v1/ledger.json" },
    })

    const texts = textOf(tree)
    expect(texts).toContain("已从旧版爪印导入 3 项，1 项没能导入。")
    expect(texts).toContain("invalid JSON in message m1")
    expect(texts).toContain("详细记录：/home/import-v1/ledger.json")
    expect(visit(tree).some((element) => element.props.role === "alert")).toBe(true)
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
