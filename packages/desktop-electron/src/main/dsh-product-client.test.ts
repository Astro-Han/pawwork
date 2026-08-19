import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vm from "node:vm"
import { describe, expect, mock, test } from "bun:test"

const repositoryRoot = resolve(import.meta.dir, "../../../..")
const productRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/product")

describe("PawWork DSH client product layer", () => {
  test("is a packaged DSH web plugin", () => {
    const productPackage = JSON.parse(readFileSync(resolve(productRoot, "package.json"), "utf8"))
    const patch = readFileSync(
      resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/home/product.cordis.patch.yml"),
      "utf8",
    )

    expect(productPackage.name).toBe("@pawwork/dsh-product")
    expect(productPackage.exports["./client"].default).toBe("./lib/client.js")
    expect(productPackage.dsh.client).toEqual({
      inject: ["@deepseek-ai/dsh-client-runtime"],
      platform: "web",
    })
    expect(patch).toContain("name: '@pawwork/dsh-product'")
  })

  test("refreshes the DSH session baseline once after v1 migration completes", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")

    expect(source).toContain('connection.rpc.call("/pawwork-import-v1", "status"')
    expect(source).toContain("await sessions.refresh()")
    expect(source).toContain("clearInterval(timer)")
  })

  test("keeps refreshing a visible automation until its active run finishes", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")

    expect(source).toContain("definition.recentRuns?.some((run) => run.state === \"running\" || run.state === \"scheduled\")")
    expect(source).toContain("const timer = setTimeout(() => void load(), 1_000)")
    expect(source).toContain("return () => clearTimeout(timer)")
  })

  test("replaces the DSH welcome notice without adding sidebar branding", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      id: string
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
        inject: string[]
      }
    } | null = null
    const document = {
      title: "DeepSeek Harness",
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const window = {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        },
      },
    }

    vm.runInNewContext(source, { document, window })
    expect(definition?.id).toBe("@pawwork/dsh-product")

    const useEffect = (effect: () => void) => effect()
    const useRef = <T>(value: T) => ({ current: value })
    const plugin = definition!.factory((name) => {
      if (name === "react") return { useEffect, useRef }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{
      options: { id?: string; priority?: number }
      component: (props: unknown) => unknown
    }> = []
    const ctx = {
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string; priority?: number }, component: (props: unknown) => unknown) => {
          registrations.push({ options, component })
        },
      },
    }

    plugin.apply(ctx)
    expect(document.title).toBe("PawWork")
    expect(plugin.inject).toEqual(["slots", "layout", "connection", "conversation", "sessions", "workspaces"])
    const welcome = registrations.find((entry) => entry.options.id === "welcome-notice")
    expect(welcome).toBeDefined()
    expect(welcome!.options.priority).toBe(-1)
    const complete = mock(() => {})
    welcome!.component({ complete })
    expect(complete).toHaveBeenCalledTimes(1)

  })

  test("owns one titlebar control and fully closes the sidebar rail", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
      }
    } | null = null
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN", dataset: {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const window = {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        },
      },
    }

    vm.runInNewContext(source, { document, navigator: { platform: "MacIntel" }, window })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const IconPanelLeftOutline16 = Symbol("IconPanelLeftOutline16")
    const plugin = definition!.factory((name) => {
      if (name === "react") return { createElement, useEffect: () => {}, useRef: <T>(value: T) => ({ current: value }) }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16 }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const toggleSidebar = mock(() => {})
    const registrations: Array<{
      options: { id?: string }
      component: () => { props: Record<string, unknown> }
    }> = []
    const ctx = {
      layout: { toggleSidebar },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string }, component: () => { props: Record<string, unknown> }) => {
          registrations.push({ options, component })
        },
      },
    }

    plugin.apply(ctx)

    const registration = registrations.find((entry) => entry.options.id === "pawwork-sidebar-toggle")
    expect(registration).toBeDefined()
    const button = registration!.component()
    expect(button.props["aria-label"]).toBe("切换侧边栏")
    expect(button.props.children[0].type).toBe(IconPanelLeftOutline16)
    expect(button.props.children[0].props.size).toBe(16)
    ;(button.props.onClick as () => void)()
    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })

  test("surfaces automations directly below New Session through the public sidebar action slot", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
      }
    } | null = null
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN", dataset: {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const window = {
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        },
      },
    }

    vm.runInNewContext(source, { document, window })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const plugin = definition!.factory((name) => {
      if (name === "react") {
        return {
          createElement,
          useEffect: (effect: () => void) => effect(),
          useRef: <T>(value: T) => ({ current: value }),
          useState: <T>(initial: T) => [initial, mock(() => {})],
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") {
        return {
          Button: "Button",
          IconCloseOutline16: "IconCloseOutline16",
          IconPanelLeftOutline16: () => null,
          IconPauseOutline16: "IconPauseOutline16",
          IconPlayOutline16: "IconPlayOutline16",
          IconRefreshOutline16: "IconRefreshOutline16",
          IconTrashOutline16: "IconTrashOutline16",
        }
      }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{
      options: { id?: string; name?: string; priority?: number }
      component: (props: { wide: boolean }) => { props: Record<string, unknown> }
      dispose: ReturnType<typeof mock>
    }> = []
    const call = mock(async () => ({ ok: true, value: { definitions: [] } }))
    const ctx = {
      connection: { rpc: { call } },
      layout: { closeDetails: () => {}, toggleSidebar: () => {} },
      sessions: { open: () => {} },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (
          options: { id?: string; name?: string; priority?: number },
          component: (props: { wide: boolean }) => { props: Record<string, unknown> },
        ) => {
          const dispose = mock(() => {})
          registrations.push({ options, component, dispose })
          return dispose
        },
      },
    }

    plugin.apply(ctx)

    const registration = registrations.find((entry) => entry.options.id === "pawwork-automations")
    expect(registration?.options.name).toBe("sidebar.footer.action")
    const button = registration!.component({ wide: true })
    expect(button.type).toBe("button")
    expect(button.props["aria-label"]).toBe("自动化")
    expect(button.props.className).toBe("pawwork-automation-entry")
    expect(button.props.children[1].props.children).toEqual(["自动化"])
    expect(typeof button.props.onClick).toBe("function")
    ;(button.props.onClick as () => void)()
    const surfaceRegistration = registrations.find((entry) => entry.options.name === "conversation")
    expect(surfaceRegistration?.options.priority).toBe(-100)
    expect(registrations.some((entry) => entry.options.id === "pawwork-automations-overlay")).toBe(false)
    expect(plugin.inject).toEqual(["slots", "layout", "connection", "conversation", "sessions", "workspaces"])
  })

  test("adds selected file paths through the public composer input slot", async () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
      }
    } | null = null
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN" },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: () => {} },
    }
    const pick = mock(async () => ({
      status: "selected",
      paths: ["/tmp/notes.md"],
    }))
    const window = {
      pawworkFiles: { pick },
      __ModuleLoader__: {
        load: (value: typeof definition) => {
          definition = value
        },
      },
    }

    vm.runInNewContext(source, { document, window })
    const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: { ...props, children },
    })
    const plugin = definition!.factory((name) => {
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
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (options: { id?: string }, component: typeof fileAction) => {
          if (options.id === "pawwork-files") fileAction = component
        },
      },
    }

    plugin.apply(ctx)
    expect(fileAction).toBeDefined()
    const setDraft = mock(() => {})
    const button = fileAction!({
      input: { draft: "请总结", phase: "plain" },
      inputActions: { setDraft },
    })
    await (button.props.onClick as () => Promise<void>)()

    expect(pick).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenCalledWith('请总结\n\n文件：\n- "/tmp/notes.md"')
  })
})
