import { expect, mock, test } from "bun:test"

mock.module("@solidjs/router", () => ({
  useNavigate: () => () => undefined,
  useParams: () => ({}),
}))

const { popularProviders } = await import("./use-providers")

test("popular providers keep OpenCode Zen, OpenCode Go, and DeepSeek visible", () => {
  expect(popularProviders).toContain("opencode")
  expect(popularProviders).toContain("opencode-go")
  expect(popularProviders).toContain("deepseek")
})
