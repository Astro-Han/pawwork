import { describe, expect, test } from "bun:test"
import type { TabsProps } from "./tabs"

describe("Tabs variant union", () => {
  test("accepts \"sidepanel\"", () => {
    // Compile-time: typecheck fails if the union drops "sidepanel".
    // Runtime: trivially passes (bun strips TS types).
    const variant: TabsProps["variant"] = "sidepanel"
    expect(variant).toBe("sidepanel")
  })

  test("accepts existing variants", () => {
    const normal: TabsProps["variant"] = "normal"
    const alt: TabsProps["variant"] = "alt"
    const pill: TabsProps["variant"] = "pill"
    const settings: TabsProps["variant"] = "settings"
    expect([normal, alt, pill, settings]).toEqual(["normal", "alt", "pill", "settings"])
  })
})
