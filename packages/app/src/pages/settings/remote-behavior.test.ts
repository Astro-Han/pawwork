import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const remoteActionCheck = String.raw`
import { createComponent } from "solid-js"
import { insert, render } from "solid-js/web"
import { mock } from "bun:test"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const append = (node, child) => {
  if (Array.isArray(child)) {
    for (const item of child) append(node, item)
    return
  }
  if (child === undefined || child === null || child === false) return
  insert(node, child)
}

const waitFor = async (predicate, message) => {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(message)
}

globalThis.React = {
  createElement(type, props, ...children) {
    if (typeof type === "function") {
      return type({ ...(props ?? {}), children: children.length === 1 ? children[0] : children })
    }

    const node = document.createElement(type)
    const classNames = []
    for (const [key, value] of Object.entries(props ?? {})) {
      if (key === "children" || value === undefined || value === null || value === false) continue
      if (key === "class" || key === "className") {
        classNames.push(String(value))
        continue
      }
      if (key === "classList" && typeof value === "object") {
        for (const [name, enabled] of Object.entries(value)) {
          if (enabled) classNames.push(name)
        }
        continue
      }
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value)
        continue
      }
      if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value)
        continue
      }
      if (key in node) {
        node[key] = value
      }
      if (value === true) node.setAttribute(key, "")
      else node.setAttribute(key, String(value))
    }
    if (classNames.length > 0) node.setAttribute("class", classNames.join(" "))

    for (const child of children) append(node, child)
    return node
  },
}

mock.module("./src/context/language.tsx", () => ({
  useLanguage: () => ({
    t: (key) => key,
  }),
}))

// Render Button/Switch/Icon as inert nodes. Bun compiles the imported .tsx to
// React.createElement, so the component renders as static DOM through this shim:
// signals and handlers run, but the tree does not re-render reactively. The action
// buttons are therefore always present (the real app toggles a hidden class instead).
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props) =>
    React.createElement(
      "button",
      { "data-action": props["data-action"], onClick: props.onClick, type: "button" },
      props.children,
    ),
}))

mock.module("@opencode-ai/ui/icon", () => ({
  Icon: (props) => React.createElement("span", { "data-icon": props.name }),
}))

mock.module("@opencode-ai/ui/switch", () => ({
  Switch: (props) =>
    React.createElement("input", {
      type: "checkbox",
      checked: props.checked,
      onClick: (event) => props.onChange?.(event.currentTarget.checked),
    }),
}))

const saved = []
const started = []
const unhandledRejections = []
let stopped = 0
let statusCalls = 0
const idleStatus = { state: "idle", platforms: ["feishu", "slack", "weixin"] }
const runningStatus = { state: "running", platforms: ["feishu", "slack", "weixin"] }
let current = idleStatus

window.addEventListener("unhandledrejection", (event) => {
  unhandledRejections.push(event.reason)
})

window.api = {
  remoteAccessConfig: async () => ({ enabled: false, platform: "feishu", options: {} }),
  remoteAccessStatus: async () => {
    statusCalls += 1
    return current
  },
  remoteAccessSaveConfig: async (config) => {
    saved.push(config)
  },
  remoteAccessStart: async (config) => {
    started.push(config)
    current = runningStatus
    return runningStatus
  },
  remoteAccessStop: async () => {
    stopped += 1
    current = idleStatus
    return idleStatus
  },
}

const { RemotePage } = await import("./src/pages/settings/remote.tsx")

const root = document.createElement("div")
document.body.append(root)
const dispose = render(() => createComponent(RemotePage, {}), root)
await waitFor(() => root.querySelector('[data-field="app_id"]'), "remote settings should render structured fields")

const setField = (key, value) => {
  const input = root.querySelector('[data-field="' + key + '"]')
  if (!input) throw new Error("missing field " + key)
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

setField("app_id", "cli_app_123")
setField("app_secret", "secret_xyz")

root.querySelector('[data-action="settings-remote-start"]').click()
await waitFor(() => started.length === 1, "start should call desktop API")
assert(started[0].enabled === true, "start should enable the persisted config")
assert(started[0].platform === "feishu", "start should reuse the selected platform")
assert(started[0].options.app_id === "cli_app_123", "start should send structured field values")
assert(started[0].options.app_secret === "secret_xyz", "start should send every required field")

root.querySelector('[data-action="settings-remote-save"]').click()
await waitFor(() => saved.length === 1, "save should call desktop API")
assert(saved[0].enabled === true, "save after start should keep remote access enabled")
assert(saved[0].platform === "feishu", "save should keep the selected platform")
assert(saved[0].options.app_id === "cli_app_123", "save should persist structured field values")

root.querySelector('[data-action="settings-remote-stop"]').click()
await waitFor(() => stopped === 1, "stop should call desktop API")
assert(statusCalls > 0, "settings should refresh bridge status through desktop API")

let rejectedStarts = 0
window.api.remoteAccessStart = async () => {
  rejectedStarts += 1
  throw new Error("bad token")
}
root.querySelector('[data-action="settings-remote-start"]').click()
await waitFor(() => rejectedStarts === 1, "start should still route rejected API calls through the handler")
await new Promise((resolve) => setTimeout(resolve, 0))
assert(unhandledRejections.length === 0, "start failures should be caught by the page")
assert(started.length === 1, "failed start should not record a successful start payload")

dispose()
root.remove()
`

describe("RemotePage behavior", () => {
  test("keeps Save, Start, and Stop actions consistent with the desktop API", () => {
    runBrowserCheck(remoteActionCheck)
  })
})
