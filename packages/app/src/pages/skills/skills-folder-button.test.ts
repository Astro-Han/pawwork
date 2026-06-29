import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

// Renders the real OpenSkillsFolderButton to lock the desktop gate and the click
// wiring that web e2e can't reach (the web build has no openPath, so it can only
// assert the button's absence). Here a faked desktop platform exercises both
// directions and the open flow end to end. No output ⇒ pass, like the other
// render-behavior checks in this package.
const openSkillsFolderButtonCheck = String.raw`
import { mock } from "bun:test"
import { createComponent } from "solid-js"
import { render } from "solid-js/web"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

globalThis.React = {
  createElement(type, props, ...children) {
    const kids = children.length <= 1 ? children[0] : children
    if (typeof type === "function") return type({ ...(props ?? {}), children: kids })
    return kids
  },
}

mock.module("@opencode-ai/ui/toast", () => ({ showToast: () => {} }))
mock.module("@/pages/layout/helpers", () => ({ errorMessage: (_err, fallback) => fallback }))
mock.module("@/context/platform", () => ({ canOpenLocalPath: (platform) => !!platform.openPath }))
mock.module("@opencode-ai/ui/button", () => ({
  Button: (props) => {
    const button = document.createElement("button")
    if (props["data-action"]) button.setAttribute("data-action", props["data-action"])
    button.addEventListener("click", () => props.onClick && props.onClick())
    button.textContent = typeof props.children === "string" ? props.children : ""
    return button
  },
}))

const pathGetCalls = []
const openPathCalls = []
const globalSDK = {
  client: {
    path: {
      get: (args) => {
        pathGetCalls.push(args)
        return Promise.resolve({ data: { skills: "/home/.agents/skills" } })
      },
    },
  },
}
const language = { t: (key) => key }

const { OpenSkillsFolderButton } = await import("./src/pages/skills/skills-folder-button.tsx")

// Desktop host (openPath present): the action renders and clicking ensures then
// opens the resolved skills path.
{
  const root = document.createElement("div")
  let resolveOpened
  const opened = new Promise((resolve) => {
    resolveOpened = resolve
  })
  const platform = {
    openPath: (path) => {
      openPathCalls.push(path)
      resolveOpened()
      return Promise.resolve()
    },
  }
  render(() => createComponent(OpenSkillsFolderButton, { globalSDK, platform, language }), root)
  const button = root.querySelector('[data-action="skill-open-folder"]')
  assert(button, "desktop host should render the open-folder action")
  assert(button.textContent === "skills.openFolder", "button should use the i18n label key")
  button.click()
  await opened
  assert(
    JSON.stringify(pathGetCalls) === JSON.stringify([{ ensureSkills: true }]),
    "click should ensure and resolve the skills path via the server",
  )
  assert(
    JSON.stringify(openPathCalls) === JSON.stringify(["/home/.agents/skills"]),
    "click should open the resolved skills path",
  )
}

// Web build (no openPath): the action is hidden.
{
  const root = document.createElement("div")
  render(() => createComponent(OpenSkillsFolderButton, { globalSDK, platform: {}, language }), root)
  assert(!root.querySelector('[data-action="skill-open-folder"]'), "web build should hide the open-folder action")
}
`

describe("OpenSkillsFolderButton", () => {
  test("gates on desktop capability and wires the open flow", () => {
    runBrowserCheck(openSkillsFolderButtonCheck)
  })
})
