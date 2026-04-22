import { describe, expect, test } from "bun:test"

describe("StatusPanel", () => {
  test("re-exports the reusable status panel component", async () => {
    const source = await Bun.file(new URL("./status-panel.tsx", import.meta.url)).text()

    expect(source.trim()).toBe('export { StatusPanel } from "./status-popover-body"')
  })
})
