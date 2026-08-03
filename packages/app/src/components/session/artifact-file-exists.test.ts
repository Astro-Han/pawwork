import { test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = `
import { createComponent, createSignal, Show, Suspense } from "solid-js"
import { insert, render } from "solid-js/web"
import { createArtifactFileExists } from "./src/components/session/artifact-file-exists.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const path = "/workspace/report.md"
let resolveStats
const pendingStats = new Promise((resolve) => {
  resolveStats = resolve
})
const root = document.createElement("div")
const fallback = document.createElement("span")
fallback.dataset.state = "fallback"
fallback.textContent = "Loading"
let loadArtifact

const Content = () => {
  const [paths, setPaths] = createSignal([])
  loadArtifact = () => setPaths([path])
  const fileExists = createArtifactFileExists(paths, () => pendingStats)
  const session = document.createElement("span")
  session.dataset.state = "session"
  session.textContent = "Session"
  const Artifact = () => {
    const content = document.createElement("span")
    content.dataset.state = "content"
    insert(content, () => fileExists(path) ? "available" : "missing")
    return content
  }
  return [
    session,
    createComponent(Show, {
      get when() {
        return paths().length > 0
      },
      get children() {
        return createComponent(Artifact, {})
      },
    }),
  ]
}

const dispose = render(
  () => createComponent(Suspense, {
    fallback,
    get children() {
      return createComponent(Content, {})
    },
  }),
  root,
)

await Promise.resolve()
await Promise.resolve()
loadArtifact()
await new Promise((resolve) => setTimeout(resolve, 10))
assert(!root.querySelector('[data-state="fallback"]'), "pending stats replaced the existing content")
assert(root.querySelector('[data-state="session"]')?.textContent === "Session", "pending stats detached the session")
assert(root.querySelector('[data-state="content"]')?.textContent === "available", "pending stats should assume the file exists")

resolveStats({ [path]: { size: 0, exists: false } })
await pendingStats
await Promise.resolve()
assert(root.querySelector('[data-state="content"]')?.textContent === "missing", "resolved stats should update the file state")
dispose()
`

test("keeps existing UI visible while file stats are pending", () => {
  runBrowserCheck(browserCheck)
})
