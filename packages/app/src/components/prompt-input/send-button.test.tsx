import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import * as uiIcon from "@opencode-ai/ui/icon"

let SendButton: typeof import("./send-button").SendButton
const originalReact = (globalThis as any).React

type Node = { type: any; props: Record<string, any>; children: Node[] }

beforeAll(async () => {
  spyOn(uiIcon, "Icon").mockImplementation((props: any) => ({ type: "Icon", props: props ?? {}, children: [] }) as any)
  SendButton = (await import("./send-button")).SendButton
})

beforeEach(() => {
  ;(globalThis as any).React = {
    createElement: (type: any, props: Record<string, any> | null, ...children: unknown[]): Node => {
      const flat: Node[] = []
      const push = (c: unknown) => {
        if (c == null || c === false) return
        if (Array.isArray(c)) c.forEach(push)
        else flat.push(c as Node)
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

function find(node: Node, predicate: (n: Node) => boolean): Node | undefined {
  if (predicate(node)) return node
  for (const child of node.children) {
    const hit = find(child, predicate)
    if (hit) return hit
  }
  return undefined
}

describe("SendButton", () => {
  test("renders submit button with arrow-up icon when not stopping", () => {
    const tree = SendButton({ stopping: false, disabled: false, "aria-label": "send" }) as unknown as Node
    expect(tree.type).toBe("button")
    expect(tree.props.type).toBe("submit")
    expect(tree.props["data-action"]).toBe("prompt-submit")
    expect(tree.props["aria-label"]).toBe("send")
    const icon = find(tree, (n) => n.type === "Icon")
    expect(icon).toBeTruthy()
    expect(icon!.props.name).toBe("arrow-up")
    expect(icon!.props["data-icon"]).toBe("arrow-up")
  })

  test("renders stop icon when stopping is true", () => {
    const tree = SendButton({ stopping: true, disabled: false, "aria-label": "stop" }) as unknown as Node
    const icon = find(tree, (n) => n.type === "Icon")
    expect(icon!.props.name).toBe("stop-square")
    expect(icon!.props["data-icon"]).toBe("stop")
  })

  test("disabled prop propagates", () => {
    const tree = SendButton({ stopping: false, disabled: true, "aria-label": "send" }) as unknown as Node
    expect(tree.props.disabled).toBe(true)
  })

  test("tabIndex is applied", () => {
    const tree = SendButton({
      stopping: false,
      disabled: false,
      "aria-label": "send",
      tabIndex: -1,
    }) as unknown as Node
    expect(tree.props.tabIndex).toBe(-1)
  })
})
