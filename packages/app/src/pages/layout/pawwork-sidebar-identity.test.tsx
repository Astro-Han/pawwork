import { describe, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"

const browserCheck = String.raw`
import { createMemo, createRenderEffect, createSignal, For } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { buildPawworkSessionSections } from "./src/pages/layout/pawwork-session-nav.ts"
import { buildPawworkSidebarCollections } from "./src/pages/layout/pawwork-sidebar-identity.ts"

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const session = (input) => ({
  slug: input.id,
  projectKey: input.projectKey,
  projectLabel: input.projectLabel,
  created: input.created,
  session: {
    id: input.id,
    title: input.title,
    directory: input.directory,
    version: "v2",
    parentID: undefined,
    messageCount: 0,
    permissions: { session: {}, share: {} },
    time: { created: input.created, updated: input.created, archived: undefined },
  },
})

const makeSections = (sessions, sortMode) => buildPawworkSessionSections({
  sessions: sessions.map((item) => ({
    id: item.session.id,
    title: item.session.title ?? "",
    directory: item.session.directory,
    projectKey: item.projectKey,
    projectLabel: item.projectLabel,
    created: item.created,
  })),
  pinnedIDs: [],
  sortMode,
})

{
  const root = document.createElement("div")
  document.body.append(root)
  const [rows, setRows] = createSignal([
    session({ id: "alpha", title: "Alpha", directory: "/repo", projectKey: "pawwork", projectLabel: "PawWork", created: 300 }),
    session({ id: "beta", title: "Beta", directory: "/repo", projectKey: "pawwork", projectLabel: "PawWork", created: 200 }),
    session({ id: "gamma", title: "Gamma", directory: "/other", projectKey: "other", projectLabel: "Other", created: 100 }),
  ])
  const sections = createMemo(() => makeSections(rows(), "time"))
  const model = createMemo(() => buildPawworkSidebarCollections({ sessions: rows(), sections: sections() }))

  const dispose = render(() => createComponent(For, {
    get each() { return model().recentRowKeys },
    children: (rowKey) => {
        const row = createMemo(() => model().rowByKey.get(rowKey))
        const el = document.createElement("div")
        el.setAttribute("data-session-id", row()?.session.id ?? "")
        createRenderEffect(() => {
          el.textContent = row()?.session.title ?? ""
        })
        return el
    },
  }), root)

  const firstAlpha = root.querySelector('[data-session-id="alpha"]')
  setRows((current) => current.map((item) => item.session.id === "alpha" ? { ...item, session: { ...item.session, title: "Alpha renamed" } } : item))
  const secondAlpha = root.querySelector('[data-session-id="alpha"]')

  assert(firstAlpha === secondAlpha, "time sort should keep unchanged row DOM nodes")
  assert(secondAlpha?.textContent === "Alpha renamed", "row data should update under stable keys")
  dispose()
  root.remove()
}

{
  const root = document.createElement("div")
  document.body.append(root)
  const [rows, setRows] = createSignal([
    session({ id: "alpha", title: "Alpha", directory: "/repo", projectKey: "pawwork", projectLabel: "PawWork", created: 300 }),
    session({ id: "beta", title: "Beta", directory: "/repo", projectKey: "pawwork", projectLabel: "PawWork", created: 200 }),
    session({ id: "gamma", title: "Gamma", directory: "/other", projectKey: "other", projectLabel: "Other", created: 100 }),
  ])
  const sections = createMemo(() => makeSections(rows(), "project"))
  const model = createMemo(() => buildPawworkSidebarCollections({ sessions: rows(), sections: sections() }))

  const dispose = render(() => createComponent(For, {
    get each() { return model().groupKeys },
    children: (groupKey) => {
        const group = createMemo(() => model().groupByKey.get(groupKey))
        const el = document.createElement("section")
        el.setAttribute("data-group-key", groupKey)
        createRenderEffect(() => {
          el.textContent = group()?.label ?? ""
        })
        return el
    },
  }), root)

  const firstGroup = root.querySelector('[data-group-key="pawwork"]')
  setRows((current) => current.map((item) => item.session.id === "alpha" ? { ...item, session: { ...item.session, title: "Alpha renamed" } } : item))
  const secondGroup = root.querySelector('[data-group-key="pawwork"]')

  assert(firstGroup === secondGroup, "project sort should keep unchanged group DOM nodes")
  dispose()
  root.remove()
}
`

describe("pawwork sidebar identity", () => {
  test("keeps row and group DOM nodes stable while row data updates", () => {
    runBrowserCheck(browserCheck)
  })
})
