import { Server } from "../../src/server/server"
import { expect, test } from "bun:test"

test("openapi does not expose tui endpoints", async () => {
  const spec = await Server.openapi()
  const paths = spec.paths ?? {}

  expect(Object.keys(paths).some((path) => path.startsWith("/tui"))).toBe(false)
})
