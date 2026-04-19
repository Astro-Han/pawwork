import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  clampRightPanelWidth,
  createSessionKeyReader,
  DEFAULT_RIGHT_PANEL_WIDTH,
  defaultSidePanelTab,
  ensureSessionKey,
  MAX_RIGHT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  pruneSessionKeys,
} from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

describe("defaultSidePanelTab", () => {
  test("defaults the unified right panel to status", () => {
    expect(defaultSidePanelTab(undefined)).toBe("status")
  })

  test("migrates the old changes tab to review", () => {
    expect(defaultSidePanelTab("changes")).toBe("review")
  })

  test("keeps files stable", () => {
    expect(defaultSidePanelTab("files")).toBe("files")
  })
})

describe("layout.rightPanel clamping", () => {
  test("DEFAULT_RIGHT_PANEL_WIDTH is 340", () => {
    expect(DEFAULT_RIGHT_PANEL_WIDTH).toBe(340)
  })

  test("clampRightPanelWidth(undefined) falls back to default", () => {
    expect(clampRightPanelWidth(undefined)).toBe(340)
  })

  test("clampRightPanelWidth(400) returns 400", () => {
    expect(clampRightPanelWidth(400)).toBe(400)
  })

  test("clampRightPanelWidth(250) clamps to min 300", () => {
    expect(clampRightPanelWidth(250)).toBe(MIN_RIGHT_PANEL_WIDTH)
    expect(MIN_RIGHT_PANEL_WIDTH).toBe(300)
  })

  test("clampRightPanelWidth(600) clamps to max 520", () => {
    expect(clampRightPanelWidth(600)).toBe(MAX_RIGHT_PANEL_WIDTH)
    expect(MAX_RIGHT_PANEL_WIDTH).toBe(520)
  })

  test("clampRightPanelWidth(NaN) falls back to default", () => {
    expect(clampRightPanelWidth(Number.NaN)).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
  })

  test("clampRightPanelWidth(Infinity) falls back to default", () => {
    expect(clampRightPanelWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
    expect(clampRightPanelWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
  })

  test("clampRightPanelWidth(string) falls back to default (corrupted persisted blob)", () => {
    // Persisted blobs from external sources could contain stringified numbers;
    // the type signature says number | undefined but defence matters.
    expect(clampRightPanelWidth("400" as unknown as number)).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
    expect(clampRightPanelWidth(null as unknown as number)).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
  })
})
