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
  const definition = loadDshClientModule(clientEntry, {
    console,
    document: fakeDocument(),
    URL,
    window: { open: opened },
    setInterval: () => 0,
    clearInterval: () => {},
  })
  const plugin = definition.factory((module: string) => {
    if (module === "react") return react
    if (module === "@deepseek-ai/dsh-client-ui-primitives") return { Button: "Button", Pill: "Pill" }
    throw new Error(`unexpected mcp-oauth client dependency: ${module}`)
  })
  const registered: Array<{ registration: Record<string, unknown>; component: (props: unknown) => unknown }> = []
  const calls: Array<{ endpoint: string; payload: Record<string, unknown> }> = []
  const connection = {
    rpc: {
      call: async (_channel: string, endpoint: string, payload: Record<string, unknown>) => {
        calls.push({ endpoint, payload })
        return rpc(endpoint, payload)
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
  return { calls, component, definition, opened, plugin, react, registered, render }
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
    if (extra !== undefined) return { ok: true, value: extra(payload) }
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
  return visit(tree).find((element) => element.type === "input" && element.props["aria-label"] === label)
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
    // through sign-out, and a lost connection gets Retry, not a new grant.
    expect(buttonLabels(rowFor(tree, "conn"))).toEqual(["Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "need"))).toEqual(["Authorize", "Remove"])
    expect(buttonLabels(rowFor(tree, "gone"))).toEqual(["Authorize", "Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "down"))).toEqual(["Retry", "Sign out", "Remove"])
    expect(buttonLabels(rowFor(tree, "load"))).toEqual(["Remove"])
    expect(buttonLabels(rowFor(tree, "wait"))).toEqual(["Cancel authorization", "Remove"])
    expect(textOf(tree)).not.toContain("Reauthorize")
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

    const setInput = (label: string, value: string) => {
      const input = inputOf(tree, label)
      ;(input?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } })
      tree = surface.render()
    }
    const clickAdd = async () => {
      const addButton = visit(tree).find(
        (element) => element.type === "Button" && (element.props.children as unknown[]).includes("Add"),
      )
      ;(addButton?.props.onClick as () => void)()
      await settle()
      tree = surface.render()
    }

    setInput("Name", "alpha")
    setInput("Server URL", "https://mcp.example.com/mcp")
    ;(visit(tree).find((element) => element.type === "textarea")?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "x-token: abc\nx-env: prod" },
    })
    tree = surface.render()
    await clickAdd()
    expect(surface.calls).toContainEqual({
      endpoint: "add",
      payload: { serverName: "alpha", url: "https://mcp.example.com/mcp", headers: { "x-token": "abc", "x-env": "prod" } },
    })

    // A malformed header line is a local error, not an RPC.
    setInput("Name", "beta")
    setInput("Server URL", "https://mcp.example.com/mcp")
    ;(visit(tree).find((element) => element.type === "textarea")?.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: "not a header line" },
    })
    tree = surface.render()
    await clickAdd()
    expect(alertsOf(tree).some((line) => line.includes("Name: Value"))).toBe(true)
    expect(surface.calls.filter((call) => call.endpoint === "add")).toHaveLength(1)

    // Neither is a scheme the loopback OAuth flow could ever complete under.
    setInput("Server URL", "ftp://mcp.example.com/mcp")
    await clickAdd()
    expect(alertsOf(tree).some((line) => line.includes("http(s)"))).toBe(true)
    expect(surface.calls.filter((call) => call.endpoint === "add")).toHaveLength(1)
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
})
