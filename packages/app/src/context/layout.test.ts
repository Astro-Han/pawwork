import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  clampRightPanelWidth,
  createDefaultLayoutState,
  createSessionKeyReader,
  DEFAULT_RIGHT_PANEL_WIDTH,
  defaultSidePanelTab,
  ensureSessionKey,
  legacyRightPanelOpened,
  migrateStoredLayout,
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

describe("default layout state", () => {
  test("starts clean desktop profiles with both side panels closed", () => {
    const state = createDefaultLayoutState()

    expect(state.sidebar.opened).toBe(false)
    expect(state.rightPanel.opened).toBe(false)
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
  test("DEFAULT_RIGHT_PANEL_WIDTH is 380", () => {
    expect(DEFAULT_RIGHT_PANEL_WIDTH).toBe(380)
  })

  test("clampRightPanelWidth(undefined) falls back to default", () => {
    expect(clampRightPanelWidth(undefined)).toBe(380)
  })

  test("clampRightPanelWidth(400) returns 400", () => {
    expect(clampRightPanelWidth(400)).toBe(400)
  })

  test("clampRightPanelWidth(300) clamps to min 360", () => {
    expect(clampRightPanelWidth(300)).toBe(MIN_RIGHT_PANEL_WIDTH)
    expect(MIN_RIGHT_PANEL_WIDTH).toBe(360)
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

describe("legacyRightPanelOpened", () => {
  test("preserves legacy review panel closed state", () => {
    expect(legacyRightPanelOpened({ width: 380 }, { panelOpened: false }, { opened: true })).toBe(false)
  })

  test("falls back to legacy file tree opened state", () => {
    expect(legacyRightPanelOpened({ width: 380 }, {}, { opened: false })).toBe(false)
  })
})

describe("migrateStoredLayout", () => {
  test("migrates legacy boolean rightPanel to the new object shape", () => {
    const migrated = migrateStoredLayout({
      rightPanel: false,
      sessionView: {},
      sessionTabs: {},
    }) as { rightPanel: { opened: boolean; width: number } }

    expect(migrated.rightPanel).toEqual({ opened: false, width: DEFAULT_RIGHT_PANEL_WIDTH })
  })

  test("preserves legacy closed review panel when right panel state is missing", () => {
    const migrated = migrateStoredLayout({
      review: { panelOpened: false },
      fileTree: { opened: true },
      sessionView: {},
      sessionTabs: {},
    }) as { rightPanel: { opened: boolean; width: number } }

    expect(migrated.rightPanel.opened).toBe(false)
    expect(migrated.rightPanel.width).toBe(DEFAULT_RIGHT_PANEL_WIDTH)
  })

  test("strips legacy mobileSidebar key while preserving sibling fields", () => {
    const migrated = migrateStoredLayout({
      mobileSidebar: { opened: true },
      sidebar: { opened: true, width: 280 },
      rightPanel: { opened: false, width: 380 },
      sessionView: {},
      sessionTabs: {},
    }) as Record<string, unknown> & {
      sidebar: { opened: boolean; width: number }
      rightPanel: { opened: boolean; width: number }
    }

    expect("mobileSidebar" in migrated).toBe(false)
    expect(migrated.sidebar).toEqual({ opened: true, width: 280 })
    expect(migrated.rightPanel).toEqual({ opened: false, width: 380 })
  })
})
