import { expect, test } from "bun:test"

test("mcp auth handling does not depend on tui events", async () => {
  const source = await Bun.file(new URL("../../src/mcp/index.ts", import.meta.url)).text()

  expect(source).not.toContain("TuiEvent")
  expect(source).not.toContain("ToastShow")
})
