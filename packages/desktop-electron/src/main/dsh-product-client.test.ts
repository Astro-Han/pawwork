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

  test("replaces the DSH welcome notice without adding sidebar branding", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    const styles: Array<{ dataset: Record<string, string>; textContent: string }> = []
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
      head: { appendChild: (style: (typeof styles)[number]) => styles.push(style) },
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
    expect(plugin.inject).toEqual(["slots", "layout"])
    const welcome = registrations.find((entry) => entry.options.id === "welcome-notice")
    expect(welcome).toBeDefined()
    expect(welcome!.options.priority).toBe(-1)
    const complete = mock(() => {})
    welcome!.component({ complete })
    expect(complete).toHaveBeenCalledTimes(1)

    expect(styles).toHaveLength(1)
    expect(styles[0].textContent).toContain('svg[viewBox="0 0 182 24"]')
    expect(styles[0].textContent).toContain('svg[viewBox="0 0 23.16 17.04"]')
    expect(styles[0].textContent).not.toContain('button:has(> svg[viewBox="0 0 182 24"])::before')
    expect(styles[0].textContent).toContain("visibility: hidden")
  })

  test("owns one titlebar control and fully closes the sidebar rail", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
      }
    } | null = null
    const styles: Array<{ dataset: Record<string, string>; textContent: string }> = []
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN", dataset: {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: (style: (typeof styles)[number]) => styles.push(style) },
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
    expect(styles[0].textContent).toContain("border-radius: 50%")
    expect(styles[0].textContent).toContain("position: fixed")
    expect(styles[0].textContent).toContain("top: 9px")
    expect(styles[0].textContent).toContain(
      'html[data-pawwork-platform="macos"] .pawwork-sidebar-toggle {\n  left: 76px;\n}',
    )
    expect(styles[0].textContent).not.toMatch(/\[data-sidebar-collapsed\] \.pawwork-sidebar-toggle/)
    expect(styles[0].textContent).toContain(
      ".pawwork-sidebar-toggle:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}",
    )
    expect(styles[0].textContent).not.toContain(".pawwork-sidebar-toggle:focus-visible")
    expect(styles[0].textContent).toContain("[data-sidebar-collapsed]")
    expect(styles[0].textContent).toContain("margin-left: -56px")
    expect(styles[0].textContent).toContain("width: calc(100% + 56px)")
    expect(styles[0].textContent).toContain("border-right: 0 !important;\n  visibility: hidden")
  })

  test("surfaces automations directly below New Session through the public sidebar action slot", () => {
    const source = readFileSync(resolve(productRoot, "lib/client.js"), "utf8")
    let definition: {
      factory: (require: (name: string) => unknown) => {
        apply(ctx: unknown): void
      }
    } | null = null
    const styles: Array<{ dataset: Record<string, string>; textContent: string }> = []
    const document = {
      title: "DeepSeek Harness",
      documentElement: { lang: "zh-CN", dataset: {} },
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: "" }),
      head: { appendChild: (style: (typeof styles)[number]) => styles.push(style) },
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
          useEffect: () => {},
          useRef: <T>(value: T) => ({ current: value }),
        }
      }
      if (name === "@deepseek-ai/dsh-client-ui-primitives") return { IconPanelLeftOutline16: () => null }
      throw new Error(`unexpected product client dependency: ${name}`)
    })
    const registrations: Array<{
      options: { id?: string; name?: string }
      component: (props: { wide: boolean }) => { props: Record<string, unknown> }
    }> = []
    const ctx = {
      layout: { toggleSidebar: () => {} },
      slots: {
        inject: (_name: string, register: () => void) => register(),
        register: (
          options: { id?: string; name?: string },
          component: (props: { wide: boolean }) => { props: Record<string, unknown> },
        ) => registrations.push({ options, component }),
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
    expect(styles[0].textContent).toContain(".pawwork-automation-entry")
    expect(styles[0].textContent).toContain("height: 42px")
    expect(styles[0].textContent).toContain("display: contents")
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
