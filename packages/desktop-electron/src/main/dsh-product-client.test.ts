import { readFileSync } from "node:fs"
import { loadDshClientModule } from "./dsh-client-module.testing"
import { resolve } from "node:path"
import { describe, expect, vi, test } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const productRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/product")

describe("PawWork DSH client product layer", () => {
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
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }

    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), { document })
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
    // 顶带替原生窗口控件占住了左上角，侧边栏品牌不再需要为它们让路：mark 和名字
    // 在所有平台上一致渲染。
    const sidebarMark = brandEntries[0].component({ size: 24 }) as { type: string; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe("svg")
    expect(sidebarMark.props).toMatchObject({ viewBox: "0 0 64 64", width: 24, height: 24 })
    expect(brandEntries[1].component({})).toBe("爪印")
    const heroMark = brandEntries[2].component({ size: 34 }) as { type: string; props: Record<string, unknown> }
    expect(heroMark.type).toBe("svg")
    expect(heroMark.props).toMatchObject({ viewBox: "0 0 64 64", width: 34, height: 34 })
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

    // 顶带必须是真元素：-webkit-app-region 对伪元素无效，拖不动窗口。
    expect(appended.map((node) => node.className)).toEqual(["pawwork-titlebar"])
    // 让位的规则全部读同一个变量，没有第二处写死的数字。变量本身只从平台来：
    // Windows 是 Chromium 的 env(titlebar-area-height)，macOS 由主进程注入覆盖。
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

  // v1 迁移在后台把冷会话逐条写进持久化，而客户端只在连接/重连时拉取冷列表：
  // 迁移结束的那一刻侧边栏不会自己更新。宿主的 import-v1 插件在
  // /pawwork-import-v1 暴露 phase。这里钉住「等到 phase 离开 running，就补一次
  // 权威列表读取，然后停」的契约——不是「轮询到某个时刻就刷一次」。
  test("refreshes the session list once the v1 import settles", async () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const timers: Array<() => void> = []
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {},
    })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const remainingPhases = ["running", "done"]
    const call = vi.fn(async () => ({ ok: true, value: { phase: remainingPhases.shift() } }))
    const refresh = vi.fn(async () => {})
    plugin.apply({
      connection: { rpc: { call } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh },
      slots: { inject: (_name: string, register: () => void) => register(), register: () => {} },
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("/pawwork-import-v1", "status", {})
    expect(refresh).not.toHaveBeenCalled()

    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(2)
    // 完成信号出现后必须读一次权威列表，而不是只在途的一次。
    expect(refresh).toHaveBeenCalledTimes(2)
    // Completion is terminal: no further poll is scheduled.
    expect(timers).toHaveLength(0)
  })

  // 传输层失败不是完成信号：旧后端没有这个通道、宿主重启窗口都只是瞬时的，
  // 客户端必须继续等，而不是数满几次失败就放弃、让侧边栏停在旧列表上。
  test("waits through transport failures until the import settles", async () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const timers: Array<() => void> = []
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {},
    })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    let failuresLeft = 2
    const call = vi.fn(async () => {
      if (failuresLeft > 0) {
        failuresLeft -= 1
        throw new Error("status channel unavailable")
      }
      return { ok: true, value: { phase: "done" } }
    })
    const refresh = vi.fn(async () => {})
    plugin.apply({
      connection: { rpc: { call } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh },
      slots: { inject: (_name: string, register: () => void) => register(), register: () => {} },
    })

    await new Promise((resolve) => setImmediate(resolve))
    // 第一次调用即失败：不停止、不刷新，只排下一轮。
    expect(call).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)

    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(2)
    expect(refresh).not.toHaveBeenCalled()
    expect(timers).toHaveLength(1)

    timers.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(3)
    // 失败结束后恢复正常：完成信号触发权威刷新，然后停。
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(timers).toHaveLength(0)
  })

  // refreshList 单飞复用仍在途的拉取，完成信号出现时可能还挂着一条迁移前的旧
  // 拉取；所以要读两次：第一次等在途的 settle，第二次才是必然全新的权威读取。
  test("issues a fresh authoritative read after any in-flight refresh settles", async () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const timers: Array<() => void> = []
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {},
    })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    // 第一次 refresh 停在在途不 resolve；第二次才开始新的拉取。
    const refresh = vi.fn()
    let firstInFlight: () => void = () => {}
    refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { firstInFlight = resolve }))
    refresh.mockImplementation(async () => {})
    const call = vi.fn(async () => ({ ok: true, value: { phase: "done" } }))
    plugin.apply({
      connection: { rpc: { call } },
      effect: (fn: () => unknown) => fn(),
      sessions: { refresh },
      slots: { inject: (_name: string, register: () => void) => register(), register: () => {} },
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(call).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    // 第一条在途：权威读取必须等它 settle，而不是并发。
    expect(refresh).toHaveBeenCalledTimes(1)
    firstInFlight()
    await new Promise((resolve) => setImmediate(resolve))
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  // 轮询器随插件而止：dispose 后不再排下一轮、也不再发 status 调用。
  test("stops polling when the client plugin is disposed", () => {
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const timers: Array<() => void> = []
    const definition = loadDshClientModule(resolve(productRoot, "lib/client.js"), {
      document,
      setTimeout: (callback: () => void) => {
        timers.push(callback)
        return timers.length
      },
      clearTimeout: () => {},
    })
    const plugin = definition.factory((name) => {
      if (name === "react") return { createElement: () => null, useEffect: () => {}, useRef: () => ({ current: null }) }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const call = vi.fn(async () => ({ ok: true, value: { phase: "running" } }))
    const refresh = vi.fn(async () => {})
    let dispose: (() => void) | undefined
    plugin.apply({
      connection: { rpc: { call } },
      effect: (fn: () => unknown) => { dispose = fn() as () => void },
      sessions: { refresh },
      slots: { inject: (_name: string, register: () => void) => register(), register: () => {} },
    })
    expect(dispose).toBeTypeOf("function")
    dispose!()
    const pending = timers.splice(0)
    for (const fire of pending) fire()
    expect(call).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(0)
  })
})
