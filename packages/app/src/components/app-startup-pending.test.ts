import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { render } from "solid-js/web"
import { createComponent } from "solid-js"
import { mock } from "bun:test"

mock.module("./src/context/language.tsx", () => ({
  useLanguage: () => ({
    t: (key) => {
      if (key === "app.startup.opening") return "正在打开爪印"
      return key
    },
  }),
}))

import { AppStartupPending } from "./src/components/app-startup-pending.tsx"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

globalThis.React = {
  createElement(type, props, ...children) {
    if (typeof type === "function") return type({ ...(props ?? {}), children })

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

const root = document.createElement("div")
document.body.append(root)
const dispose = render(() => createComponent(AppStartupPending, {}), root)

const state = root.querySelector('[data-component="app-startup-pending"]')
assert(state, "startup pending state should render")
assert(state.getAttribute("role") === "status", "startup pending state should expose status semantics")
assert(state.getAttribute("aria-label") === "正在打开爪印", "startup pending aria-label should follow the active locale")

dispose()
root.remove()
`

describe("AppStartupPending", () => {
  test("uses the active locale for its status label", () => {
    runBrowserCheck(browserCheck)
  })
})
