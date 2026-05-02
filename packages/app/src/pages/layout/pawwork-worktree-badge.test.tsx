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
  mock.module("@opencode-ai/ui/tooltip", () => ({
    Tooltip: (props: any) =>
      ({
        type: "Tooltip",
        props: props ?? {},
        children: Array.isArray(props?.children) ? props.children : [props?.children].filter(Boolean),
      }) as Node,
    TooltipKeybind: (props: any) =>
      ({
        type: "TooltipKeybind",
        props: props ?? {},
        children: Array.isArray(props?.children) ? props.children : [props?.children].filter(Boolean),
      }) as Node,
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
  test("shows only the worktree name in the visible titlebar label", () => {
    const onClick = () => undefined
    const tree = PawworkWorktreeBadge({
      name: "feature-c",
      branch: "pawwork/feature-c",
      directory: "/repo/.worktrees/pawwork/feature-c",
      ariaLabel: "Open worktrees",
      onClick,
      disabled: true,
    }) as unknown as Node

    const button = find(tree, (node) => node.type === "button")
    const label = find(tree, (node) => node.type === "span" && node.children.join("") === "feature-c")
    expect(label?.children.join("")).toBe("feature-c")
    expect(button?.props.title).toBeUndefined()
    expect(button?.props.onClick).toBe(onClick)
    expect(button?.props["aria-label"]).toBe("Open worktrees")
    expect(button?.props.disabled).toBe(true)
  })

  test("keeps visible label compact and shows three ordered hover rows", () => {
    const tree = PawworkWorktreeBadge({
      name: "very-long-worktree-name-used-for-titlebar-regression",
      branch: "pawwork/very-long-worktree-name-used-for-titlebar-regression",
      directory: "/repo/.worktrees/pawwork/very-long-worktree-name-used-for-titlebar-regression",
      ariaLabel: "Open worktrees",
      onClick: () => undefined,
    }) as unknown as Node

    const tooltip = find(tree, (node) => node.type === "Tooltip")
    const button = find(tree, (node) => node.type === "button")
    const label = find(tree, (node) => node.type === "span" && node.children.join("").startsWith("very-long-worktree"))

    expect(button?.props.class).toContain("max-w-[280px]")
    expect(label?.children.join("")).toBe("very-long-worktree-name-used-for-titlebar-regression")
    expect(tooltip?.props.placement).toBe("bottom")
    expect(tooltip?.props.value).toMatchObject({
      type: "div",
      props: { "data-component": "pawwork-worktree-tooltip" },
      children: [
        expect.objectContaining({
          children: expect.arrayContaining([expect.objectContaining({ children: ["Worktree"] })]),
        }),
        expect.objectContaining({
          children: expect.arrayContaining([expect.objectContaining({ children: ["Branch"] })]),
        }),
        expect.objectContaining({
          children: expect.arrayContaining([expect.objectContaining({ children: ["Location"] })]),
        }),
      ],
    })
  })
})
