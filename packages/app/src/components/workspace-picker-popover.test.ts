import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { render } from "solid-js/web"
import { createComponent } from "solid-js"
import { mock } from "bun:test"

mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props) => {
    const node = document.createElement("span")
    node.dataset.icon = props.name
    return node
  },
}))

mock.module("./src/context/language.tsx", () => ({
  useLanguage: () => ({
    t: (key) => {
      const labels = {
        "workspace.chip.add": "打开项目",
        "workspace.chip.directStart": "快速开始",
        "workspace.chip.empty": "没有工作目录",
        "workspace.chip.popover.title": "工作目录",
      }
      return labels[key] ?? key
    },
  }),
}))

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
      if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value)
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
      if (typeof child === "function") {
        append(child())
        return
      }
      if (child === undefined || child === null || child === false) return
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    for (const child of children) append(child)
    return node
  },
}

import { WorkspacePickerMenu } from "./src/components/workspace-picker-popover.tsx"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const root = document.createElement("div")
document.body.append(root)
let selected = ""
let opened = 0

const dispose = render(
  () =>
    createComponent(WorkspacePickerMenu, {
      current: () => "/repo/chunke",
      directStartDirectory: () => undefined,
      projects: () => [{ worktree: "/repo/chunke" }],
      onSelect: (path) => {
        selected = path
      },
      onAdd: () => {
        opened += 1
      },
    }),
  root,
)

const menu = root.querySelector('[role="menu"]')
assert(menu, "workspace picker menu should render")
assert(menu.getAttribute("aria-label") === "工作目录", "workspace picker menu should use the shared title")
assert(root.textContent.includes("chunke"), "workspace picker should list the existing project")

const project = root.querySelector('[role="menuitemradio"]')
assert(project, "workspace picker should expose the project as a selectable menu item")
assert(project.getAttribute("aria-checked") === "true", "workspace picker should mark the current project")
project.click()
assert(selected === "/repo/chunke", "workspace picker should select the existing project")

const add = root.querySelector('[data-action="workspace-chip-add"]')
assert(add, "workspace picker should keep the shared open-project action")
assert(add.textContent.includes("打开项目"), "workspace picker should label the shared open-project action")
add.click()
assert(opened === 1, "workspace picker should call the shared open-project handler")

dispose()
root.remove()
`

describe("WorkspacePickerMenu", () => {
  test("keeps open-project available when a single project is already listed", () => {
    runBrowserCheck(browserCheck)
  })
})
