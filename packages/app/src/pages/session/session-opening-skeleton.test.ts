import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { render } from "solid-js/web"
import { createComponent } from "solid-js"
import { SessionOpeningSkeleton } from "./src/pages/session/session-opening-skeleton.tsx"

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
      if (key === "classList") {
        for (const [name, active] of Object.entries(value)) {
          if (active) classNames.push(name)
        }
        continue
      }
      if (key === "style" && typeof value === "object") {
        for (const [name, styleValue] of Object.entries(value)) node.style.setProperty(name, String(styleValue))
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
const dispose = render(() => createComponent(SessionOpeningSkeleton, {
  visible: true,
  transitioning: true,
  openingLabel: "Opening session...",
}), root)

const state = root.querySelector('[data-component="session-opening-state"]')
assert(state, "opening skeleton should render a status root")
assert(state.getAttribute("role") === "status", "opening skeleton should expose status semantics")
assert(state.getAttribute("data-state") === "skeleton", "opening state should use skeleton mode")
assert(state.querySelectorAll('[data-component="session-opening-skeleton-turn"]').length === 4, "skeleton should mirror a multi-turn timeline")
assert(state.querySelectorAll('[data-side="user"]').length === 2, "skeleton should include user-shaped rows")
assert(state.querySelectorAll('[data-side="assistant"]').length === 2, "skeleton should include assistant-shaped rows")
assert(state.querySelector("button") === null, "opening skeleton should not show retry/action buttons")
assert(state.querySelector(".animate-spin") === null, "opening skeleton should not show a spinner")
assert(state.textContent.includes("Opening session..."), "opening label should remain available to assistive tech")

dispose()
root.remove()
`

describe("SessionOpeningSkeleton", () => {
  test("renders timeline-shaped opening state without spinner or action card", () => {
    runBrowserCheck(browserCheck)
  })
})
