import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const dialogSource = readFileSync(new URL("./dialog-select-server.tsx", import.meta.url), "utf8")
const defaultsSource = readFileSync(new URL("./dialog-select-server-default.ts", import.meta.url), "utf8")
const formSource = readFileSync(new URL("./dialog-select-server-form.tsx", import.meta.url), "utf8")
const listSource = readFileSync(new URL("./dialog-select-server-list.tsx", import.meta.url), "utf8")

describe("dialog-select-server source boundary", () => {
  test("keeps server form, list, and preview/default hooks in their owner files", () => {
    expect(dialogSource).toContain("ServerForm")
    expect(dialogSource).toContain("ServerConnectionList")
    expect(dialogSource).toContain("useDefaultServer")
    expect(dialogSource).toContain("useServerPreview")
    expect(defaultsSource).toContain("export function useDefaultServer")
    expect(defaultsSource).toContain("export function useServerPreview")
    expect(formSource).toContain("export function ServerForm")
    expect(listSource).toContain("export function ServerConnectionList")
  })

  test("preserves add/edit fields and list menu actions after extraction", () => {
    for (const key of [
      "dialog.server.add.url",
      "dialog.server.add.name",
      "dialog.server.add.username",
      "dialog.server.add.password",
    ]) {
      expect(formSource).toContain(key)
    }

    for (const key of [
      "dialog.server.menu.edit",
      "dialog.server.menu.default",
      "dialog.server.menu.defaultRemove",
      "dialog.server.menu.delete",
      "dialog.server.status.default",
    ]) {
      expect(listSource).toContain(key)
    }
  })
})
