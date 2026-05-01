import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"

let PawworkWorktreeBadge: typeof import("./pawwork-worktree-badge").PawworkWorktreeBadge
const originalReact = (globalThis as any).React

type Node = { type: any; props: Record<string, any>; children: Array<Node | string> }

beforeAll(async () => {
  mock.module("@opencode-ai/ui/button", () => ({
    Button: (props: any) =>
      ({
        type: "button",
        props: props ?? {},
        children: Array.isArray(props?.children) ? props.children : [props?.children].filter(Boolean),
      }) as Node,
  }))
  mock.module("@opencode-ai/ui/icon", () => ({
    Icon: (props: any) => ({ type: "Icon", props: props ?? {}, children: [] }) as Node,
  }))
  PawworkWorktreeBadge = (await import("./pawwork-worktree-badge")).PawworkWorktreeBadge
})

beforeEach(() => {
  ;(globalThis as any).React = {
    createElement: (type: any, props: Record<string, any> | null, ...children: unknown[]): Node | string => {
      const flat: Array<Node | string> = []
      const push = (child: unknown) => {
        if (child == null || child === false) return
        if (Array.isArray(child)) child.forEach(push)
        else flat.push(child as Node | string)
      }
      children.forEach(push)
      if (typeof type === "function") {
        return type({ ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat })
      }
      return { type, props: props ?? {}, children: flat }
    },
  }
})

afterAll(() => {
  mock.restore()
  if (originalReact === undefined) delete (globalThis as any).React
  else (globalThis as any).React = originalReact
})

function find(node: Node | string, predicate: (n: Node) => boolean): Node | undefined {
  if (typeof node === "string") return undefined
  if (predicate(node)) return node
  for (const child of node.children) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return undefined
}

describe("PawworkWorktreeBadge", () => {
  test("shows worktree name and branch in the visible titlebar label", () => {
    const onClick = () => undefined
    const tree = PawworkWorktreeBadge({
      name: "feature-c",
      branch: "pawwork/feature-c",
      directory: "/repo/.worktrees/pawwork/feature-c",
      ariaLabel: "Open worktrees",
      onClick,
      disabled: true,
    }) as unknown as Node

    const label = find(tree, (node) => node.type === "span")
    expect(label?.children.join("")).toBe("feature-c (pawwork/feature-c)")
    expect(tree.props.title).toBe("pawwork/feature-c · /repo/.worktrees/pawwork/feature-c")
    expect(tree.props.onClick).toBe(onClick)
    expect(tree.props["aria-label"]).toBe("Open worktrees")
    expect(tree.props.disabled).toBe(true)
  })
})
