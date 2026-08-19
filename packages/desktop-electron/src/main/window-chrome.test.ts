import { expect, test } from "bun:test"
import { macTrafficLightPosition } from "./window-chrome"

test("macOS traffic lights use the DSH shell position", () => {
  expect(macTrafficLightPosition()).toEqual({
    x: 12,
    y: 16,
  })
})
