import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { render } from "solid-js/web"
import { createComponent } from "solid-js"
import { mock } from "bun:test"

const button = (props = {}) => {
  const node = document.createElement("button")
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === "class" || key === "className" || key === "children" || key === "as" || key === "icon") continue
    node.setAttribute(key, String(value))
  }
  if (props.children) node.append(String(props.children))
  return node
}

mock.module("@opencode-ai/ui/dropdown-menu", () => {
  const DropdownMenu = (props) => props.children
  DropdownMenu.Trigger = (props) => button(props)
  DropdownMenu.Portal = (props) => props.children
  DropdownMenu.Content = (props) => {
    const node = document.createElement("div")
    if (props.children) node.append(props.children)
    return node
  }
  DropdownMenu.Item = (props) => button(props)
  DropdownMenu.ItemLabel = (props) => props.children
  return { DropdownMenu }
})

mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props) => {
    const node = document.createElement("span")
    node.dataset.icon = props.name
    return node
  },
}))
mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: button }))
mock.module("@opencode-ai/ui/tooltip", () => ({ Tooltip: (props) => props.children }))
mock.module("./src/context/language.tsx", () => ({ useLanguage: () => ({ t: (key) => key }) }))

globalThis.React = {
  createElement(type, props, ...children) {
    const normalizedChildren = children.length === 1 ? children[0] : children
    if (typeof type === "function") return type({ ...(props ?? {}), children: normalizedChildren })

    const node = document.createElement(type)
    const classNames = []
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === undefined || value === null || value === false) continue
      if (key === "class" || key === "className") {
        classNames.push(String(value))
        continue
      }
      node.setAttribute(key, String(value))
    }
    if (classNames.length > 0) node.setAttribute("class", classNames.join(" "))

    const append = (child) => {
      if (Array.isArray(child)) {
        for (const item of child) append(item)
        return
      }
      if (child === undefined || child === null || child === false) return
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    for (const child of children) append(child)
    return node
  },
}

import { PawworkSidebarAllHeader } from "./src/pages/layout/pawwork-sidebar-all-header.tsx"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () =>
    createComponent(PawworkSidebarAllHeader, {
      sortMode: () => "time",
      onSetSortMode: () => undefined,
      workspacePicker: () => {
        const node = document.createElement("button")
        node.dataset.action = "pawwork-workspace-picker"
        node.textContent = "工作目录"
        return node
      },
    }),
  root,
)

assert(
  root.querySelector('[data-action="pawwork-workspace-picker"]'),
  "sidebar all header should render the shared workspace picker trigger",
)
assert(root.querySelector('[data-action="pawwork-sort-trigger"]'), "sidebar all header should keep the sort trigger")

dispose()
root.remove()
`

describe("PawworkSidebarAllHeader", () => {
  test("renders the workspace picker trigger beside sorting", () => {
    runBrowserCheck(browserCheck)
  })
})
