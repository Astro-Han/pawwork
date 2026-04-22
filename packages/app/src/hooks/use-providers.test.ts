import { expect, mock, test } from "bun:test"

mock.module("@solidjs/router", () => ({
  useParams: () => ({}),
}))

const { popularProviders } = await import("./use-providers")

test("popular providers keep OpenCode Zen and OpenCode Go visible", () => {
  expect(popularProviders).toContain("opencode")
  expect(popularProviders).toContain("opencode-go")
})
