import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { loadDshClientModule } from "./dsh-client-module.testing"

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const clientEntry = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/mcp-oauth/lib/client.js")

// The Integrations surface is evaluated by the Host out of this file; this
// harness is the only thing that executes it, so the fake runtime below has to
// be honest: real state cells, effects that run, and a `require` that refuses
// anything the client does not declare.

type Element = { type: unknown; props: Record<string, unknown> }

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

function fakeDocument() {
  return {
    documentElement: { lang: "en" },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} },
  }
}

/** Just enough React for this surface: real state cells, one-shot effects. */
function fakeReact() {
  const cells: unknown[] = []
  let cursor = 0
  const pendingEffects: Array<() => unknown> = []
  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index])
  return {
    createElement,
    Fragment: "Fragment",
    useId() {
      return `:r${cursor++}:`
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (index >= cells.length) cells[index] = { current: initial }
      return cells[index]
    },
    useState(initial: unknown) {
      const index = cursor++
      if (index >= cells.length) cells[index] = initial
      return [
        cells[index],
        (next: unknown) => {
          cells[index] = typeof next === "function" ? (next as (prev: unknown) => unknown)(cells[index]) : next
        },
      ]
    },
    useCallback(fn: unknown) {
      const index = cursor++
      if (cells[index] === undefined) cells[index] = fn
      return cells[index]
    },
    useEffect(fn: () => unknown, deps: unknown[]) {
      const index = cursor++
      const held = cells[index] as { deps: unknown[] } | undefined
      if (held !== undefined && sameDeps(held.deps, deps)) return
      cells[index] = { deps }
      pendingEffects.push(fn)
    },
    beginRender() {
      cursor = 0
    },
    flushEffects() {
      for (const effect of pendingEffects.splice(0)) effect()
    },
  }
}

type Status = {
  servers: Array<Record<string, unknown>>
  fileError?: string
}

type Rpc = (endpoint: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>

function mountSurface(rpc: Rpc) {
  const react = fakeReact()
  const opened = vi.fn()
  let tick: (() => void) | undefined
  const definition = loadDshClientModule(clientEntry, {
    console,
    document: fakeDocument(),
    URL,
    window: { open: opened },
    setInterval: (fn: () => void) => {
      tick = fn
      return 0
    },
    clearInterval: () => {},
  })
  const plugin = definition.factory((module: string) => {
    if (module === "react") return react
    if (module === "@deepseek-ai/dsh-client-ui-primitives") return { Button: "Button", IconPlusOutline16: "Icon", Modal: "Modal", Tag: "Tag" }
    throw new Error(`unexpected mcp-oauth client dependency: ${module}`)
  })
  const registered: Array<{ registration: Record<string, unknown>; component: (props: unknown) => unknown }> = []
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const connection = {
    rpc: {
      call: async (channel: string, endpoint: string, payload: { args: Record<string, unknown> }) => {
        const [namespace, method] = endpoint.split("/")
        if (channel !== "/api" || namespace !== "mcpAuth" || Object.keys(payload).join() !== "args") {
          throw new Error(`unexpected Remote call: ${channel} ${endpoint}`)
        }
        calls.push({ endpoint: method, payload: payload.args })
        return rpc(method, payload.args)
      },
    },
  }
  plugin.apply({
    get: (service: string) => {
      throw new Error(`the surface reached for a service it does not declare: ${service}`)
    },
    effect: (run: () => unknown) => run(),
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (registration: Record<string, unknown>, component: (props: unknown) => unknown) => {
        registered.push({ registration, component })
        return () => {}
      },
    },
    connection,
  })
  const component = registered[0]?.component
  if (component === undefined) throw new Error("no settings.section registered")
  const render = () => {
    react.beginRender()
    const tree = component({})
    react.flushEffects()
    return tree
  }
  return { calls, component, definition, opened, plugin, react, registered, render, tick: () => tick?.() }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Render, let the effect's status fetch resolve, render again with the answer. */
async function renderSettled(surface: ReturnType<typeof mountSurface>) {
  surface.render()
  await settle()
  return surface.render()
}

function statusRpc(status: Status | (() => Status), extras: Record<string, (payload: Record<string, unknown>) => unknown> = {}): Rpc {
  const read = typeof status === "function" ? status : () => status
  return async (endpoint, payload) => {
    const extra = extras[endpoint]
    if (extra !== undefined) {
      const produced = extra(payload) as Record<string, unknown>
      if (produced !== null && typeof produced === "object" && "error" in produced) return produced as never
      return { ok: true, value: produced }
    }
    if (endpoint === "status") return { ok: true, value: read() }
    return { ok: true, value: read() }
  }
}

function rowsOf(tree: unknown) {
  return visit(tree).filter((element) => element.props.className === "pawwork-mcp-row")
}

function rowFor(tree: unknown, serverName: string) {
  return rowsOf(tree).find((row) => row.props.key === serverName)
}

function buttonsOf(row: Element | undefined) {
  if (row === undefined) return []
  return visit(row).filter((element) => element.type === "Button")
}

function buttonLabels(row: Element | undefined) {
  return buttonsOf(row).map((button) => (button.props.children as unknown[]).flat().join(""))
}

function alertsOf(tree: unknown) {
  return visit(tree)
    .filter((element) => element.props.role === "alert")
    .flatMap((element) => (element.props.children as unknown[]).flat().map(String))
}

function inputOf(tree: unknown, label: string) {
  const id = visit(tree).find((element) => element.type === "label" && (element.props.children as unknown[]).includes(label))?.props.htmlFor
  return visit(tree).find((element) => element.props.id === id)
}

function fieldChange(element: Element | undefined, value: string) {
  ;(element?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
}

function textOf(tree: unknown) {
  return visit(tree).flatMap((element) => (element.props.children as unknown[]).flat().map(String))
}

describe("PawWork remote MCP integrations surface", () => {
  test("registers one Integrations section and declares only the services it uses", () => {
    const { definition, plugin, registered } = mountSurface(async () => ({ ok: true, value: { servers: [] } }))
    expect(definition.id).toBe("@pawwork/dsh-mcp-oauth")
    expect(plugin.inject).toEqual(["slots", "connection"])
    expect(registered).toHaveLength(1)
    expect(registered[0]?.registration).toMatchObject({ name: "settings.section", id: "pawwork-mcp-oauth" })
  })

  test("each server state shows only the actions that are safe for it", async () => {
    const status: Status = {
      servers: [
        { serverName: "conn", url: "https://a.example/mcp", state: "connected" },
        { serverName: "need", url: "https://b.example/mcp", state: "unauthorized" },
        { serverName: "gone", url: "https://c.example/mcp", state: "expired" },
        { serverName: "down", url: "https://d.example/mcp", state: "disconnected" },
        { serverName: "load", url: "https://e.example/mcp", state: "connecting" },
        { serverName: "wait", url: "https://f.example/mcp", state: "unauthorized", authorizationPending: true },
      ],
    }
    const surface = mountSurface(statusRpc(status))
    const tree = await renderSettled(surface)

    // A connected server offers no reauthorize path: switching accounts goes
    // through sign-out. Retry stays available because a startup load reports
    // connected while the bridge may still be retrying in the background.
    expect(buttonLabels(rowFor(tree, "conn"))).toEqual(["Retry", "Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "need"))).toEqual(["Authorize", "Remove"])
    expect(buttonLabels(rowFor(tree, "gone"))).toEqual(["Reauthorize", "Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "down"))).toEqual(["Retry", "Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "load"))).toEqual(["Remove"])
    expect(buttonLabels(rowFor(tree, "wait"))).toEqual(["Cancel authorization", "Remove"])
    const tags = visit(tree).filter((element) => element.type === "Tag").map((tag) => [tag.props.tone, ...(tag.props.children as unknown[])].join(":"))
    expect(tags).toEqual([
      "success:Connected",
      "warning:Not authorized",
      "warning:Authorization expired",
      "danger:Connection failed",
      "info:Connecting",
      "info:Waiting for authorization",
    ])
  })

  test("a file error is surfaced instead of silently showing an empty list", async () => {
    const surface = mountSurface(statusRpc({ servers: [], fileError: "mcp-oauth.json: unexpected token" }))
    const tree = await renderSettled(surface)
    expect(alertsOf(tree).some((line) => line.includes("could not be read"))).toBe(true)
  })

  test("authorize opens the URL the engine returned", async () => {
    const status: Status = { servers: [{ serverName: "alpha", url: "https://a.example/mcp", state: "unauthorized" }] }
    const surface = mountSurface(
      statusRpc(status, {
        authorize: () => ({ authorizationUrl: "https://as.example/authorize?client_id=x" }),
      }),
    )
    let tree = await renderSettled(surface)
    const authorize = buttonsOf(rowFor(tree, "alpha")).find((button) => (button.props.children as unknown[]).includes("Authorize"))
    ;(authorize?.props.onClick as () => void)()
    await settle()
    expect(surface.calls.map((call) => call.endpoint)).toContain("authorize")
    expect(surface.opened).toHaveBeenCalledWith("https://as.example/authorize?client_id=x", "_blank", "noopener")
  })

  test("add posts parsed headers; malformed lines and non-web URLs never reach the wire", async () => {
    const status: Status = { servers: [] }
    const surface = mountSurface(statusRpc(status))
    let tree = await renderSettled(surface)

    // The form sits behind the dashed add button.
    const openAdd = visit(tree).find((element) => element.props.className === "pawwork-mcp-add-button")
    ;(openAdd?.props.onClick as () => void)()
    tree = surface.render()

    const setInput = (label: string, value: string) => {
      fieldChange(inputOf(tree, label), value)
      tree = surface.render()
    }
    const setHeaders = (value: string) => {
      fieldChange(visit(tree).find((element) => element.type === "textarea"), value)
      tree = surface.render()
    }
    const submit = async () => {
      const form = visit(tree).find((element) => element.type === "form")
      ;(form?.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} })
      await settle()
      tree = surface.render()
    }

    setInput("Name", "alpha")
    setInput("Server URL", "https://mcp.example.com/mcp")
    setHeaders("x-token: abc\nx-env: prod")
    await submit()
    expect(surface.calls).toContainEqual({
      endpoint: "add",
      payload: { serverName: "alpha", url: "https://mcp.example.com/mcp", headers: { "x-token": "abc", "x-env": "prod" } },
    })

    // A successful add closes the form; open it again for the refusals.
    expect(visit(tree).find((element) => element.type === "form")).toBeUndefined()
    ;(visit(tree).find((element) => element.props.className === "pawwork-mcp-add-button")?.props.onClick as () => void)()
    tree = surface.render()

    // A malformed header line is a local error next to its field, not an RPC.
    setInput("Name", "beta")
    setInput("Server URL", "https://mcp.example.com/mcp")
    setHeaders("not a header line")
    await submit()
    expect(alertsOf(tree).some((line) => line.includes("Name: Value"))).toBe(true)
    expect(inputOf(tree, "One per line, written as Name: Value")?.props["aria-invalid"]).toBe(true)
    expect(surface.calls.filter((call) => call.endpoint === "add")).toHaveLength(1)

    // Neither is a scheme the loopback OAuth flow could ever complete under.
    setHeaders("")
    setInput("Server URL", "ftp://mcp.example.com/mcp")
    await submit()
    expect(alertsOf(tree).some((line) => line.includes("https://"))).toBe(true)
    expect(inputOf(tree, "Server URL")?.props["aria-invalid"]).toBe(true)
    expect(surface.calls.filter((call) => call.endpoint === "add")).toHaveLength(1)
  })

  test("an add the engine refuses is reported inside the form", async () => {
    const surface = mountSurface(
      statusRpc({ servers: [] }, { add: () => ({ ok: false, error: { message: "mcp-oauth: server alpha is already configured" } }) }),
    )
    let tree = await renderSettled(surface)
    ;(visit(tree).find((element) => element.props.className === "pawwork-mcp-add-button")?.props.onClick as () => void)()
    tree = surface.render()
    fieldChange(inputOf(tree, "Name"), "alpha")
    tree = surface.render()
    fieldChange(inputOf(tree, "Server URL"), "https://mcp.example.com/mcp")
    tree = surface.render()
    const form = visit(tree).find((element) => element.type === "form")
    ;(form?.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault() {} })
    await settle()
    tree = surface.render()
    const inForm = visit(visit(tree).find((element) => element.type === "form")).filter((element) => element.props.role === "alert")
    expect(inForm.map((element) => (element.props.children as unknown[]).join(""))).toEqual(["A server with that name is already configured."])
  })

  test("remove asks first and keeps the dialog open until the engine answers", async () => {
    let status: Status = { servers: [{ serverName: "alpha", url: "https://a.example/mcp", state: "connected" }] }
    const surface = mountSurface(
      statusRpc(() => status, {
        remove: () => {
          status = { servers: [] }
          return status
        },
      }),
    )
    let tree = await renderSettled(surface)
    const modalOf = (node: unknown) => visit(node).find((element) => element.type === "Modal")
    expect(modalOf(tree)?.props.open).toBe(false)
    const remove = buttonsOf(rowFor(tree, "alpha")).find((button) => (button.props.children as unknown[]).includes("Remove"))
    ;(remove?.props.onClick as () => void)()
    tree = surface.render()
    expect(surface.calls.map((call) => call.endpoint)).not.toContain("remove")
    expect(modalOf(tree)?.props).toMatchObject({ open: true, title: "Remove alpha?" })
    const confirm = visit(modalOf(tree)?.props.footer).find((element) => element.type === "Button" && (element.props.children as unknown[]).includes("Remove"))
    ;(confirm?.props.onClick as () => void)()
    await settle()
    tree = surface.render()
    expect(surface.calls).toContainEqual({ endpoint: "remove", payload: { serverName: "alpha" } })
    expect(modalOf(tree)?.props.open).toBe(false)
    expect(rowsOf(tree)).toHaveLength(0)
  })

  test("sign out and retry hit their endpoints and apply the returned status", async () => {
    let status: Status = { servers: [{ serverName: "alpha", url: "https://a.example/mcp", state: "connected" }] }
    const surface = mountSurface(
      statusRpc(() => status, {
        signOut: () => {
          status = { servers: [{ serverName: "alpha", url: "https://a.example/mcp", state: "unauthorized" }] }
          return status
        },
      }),
    )
    // status answers reflect whatever the fake currently holds.
    let tree = await renderSettled(surface)
    const signOut = buttonsOf(rowFor(tree, "alpha")).find((button) => (button.props.children as unknown[]).includes("Sign out"))
    ;(signOut?.props.onClick as () => void)()
    await settle()
    tree = surface.render()
    expect(surface.calls).toContainEqual({ endpoint: "signOut", payload: { serverName: "alpha" } })
    expect(buttonLabels(rowFor(tree, "alpha"))).toEqual(["Authorize", "Remove"])
  })

  test("an action error survives a successful background status refresh", async () => {
    const surface = mountSurface(
      statusRpc(
        { servers: [{ serverName: "alpha", url: "https://a.example/mcp", state: "connected" }] },
        { signOut: () => ({ ok: false, error: { message: "sign-out blew up" } }) },
      ),
    )
    let tree = await renderSettled(surface)
    const signOut = buttonsOf(rowFor(tree, "alpha")).find((button) => (button.props.children as unknown[]).includes("Sign out"))
    ;(signOut?.props.onClick as () => void)()
    await settle()
    tree = surface.render()
    expect(alertsOf(tree).some((line) => line.includes("sign-out blew up"))).toBe(true)
    // The next poll succeeds — and must not erase what the failed action said.
    surface.tick()
    await settle()
    tree = surface.render()
    expect(alertsOf(tree).some((line) => line.includes("sign-out blew up"))).toBe(true)
  })
})
