import { expect, test } from "vitest"
import { macTrafficLightPosition, pawworkWindowTitle } from "./window-chrome"

test("macOS traffic lights use the DSH shell position", () => {
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: 10,
  })
})

test.each([
  ["DeepSeek Harness", "PawWork"],
  ["Quarterly plan — DeepSeek Harness", "Quarterly plan — PawWork"],
  ["Quarterly plan", "Quarterly plan"],
])("maps the DSH page title %s to the PawWork window title", (pageTitle, expected) => {
  expect(pawworkWindowTitle(pageTitle)).toBe(expected)
})
