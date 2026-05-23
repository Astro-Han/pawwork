import { describe, expect, test } from "bun:test"
import {
  buildPawworkSessionSections,
  findPawworkSessionNavigationTarget,
  flattenPawworkSessionSections,
  reorderPawworkPinnedByVisible,
  unpinPawworkSession,
  type PawworkSessionItem,
} from "./pawwork-session-nav"

const sessions: PawworkSessionItem[] = [
  {
    id: "beta",
    title: "Release notes",
    directory: "/repo",
    projectKey: "pawwork",
    projectLabel: "pawwork",
    created: 200,
  },
  {
    id: "gamma",
    title: "OpenCLI comparison",
    directory: "/repo",
    projectKey: "research",
    projectLabel: "research",
    created: 100,
  },
  {
    id: "alpha",
    title: "Q2 narrative",
    directory: "/repo",
    projectKey: "pawwork",
    projectLabel: "pawwork",
    created: 300,
  },
]

describe("buildPawworkSessionSections", () => {
  test("places pinned sessions first and removes them from recent", () => {
    const result = buildPawworkSessionSections({
      sessions,
      pinnedIDs: ["beta"],
      sortMode: "time",
    })

    expect(result.pinned.map((item) => item.id)).toEqual(["beta"])
    expect(result.recent.map((item) => item.id)).toEqual(["alpha", "gamma"])
  })

  test("groups unpinned sessions by project when sort mode is project", () => {
    const result = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "project",
    })

    expect(result.groups.map((group) => group.label)).toEqual(["pawwork", "research"])
    expect(result.groups[0].items.map((item) => item.id)).toEqual(["alpha", "beta"])
  })

  test("uses id ascending as the creation-time tiebreaker", () => {
    const tied = [
      { ...sessions[0], id: "zeta", created: 400 },
      { ...sessions[1], id: "alpha", created: 400 },
      { ...sessions[2], id: "middle", created: 300 },
    ]

    const byTime = buildPawworkSessionSections({
      sessions: tied,
      pinnedIDs: [],
      sortMode: "time",
    })
    expect(byTime.recent.map((item) => item.id)).toEqual(["alpha", "zeta", "middle"])

    const byProject = buildPawworkSessionSections({
      sessions: tied,
      pinnedIDs: [],
      sortMode: "project",
    })
    expect(byProject.groups.flatMap((group) => group.items.map((item) => item.id))).toEqual([
      "alpha",
      "zeta",
      "middle",
    ])
  })
})

describe("flattenPawworkSessionSections", () => {
  test("returns pinned sessions before time-sorted recent sessions", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: ["beta"],
      sortMode: "time",
    })

    const result = flattenPawworkSessionSections(sections)

    expect(result.map((entry) => entry.item.id)).toEqual(["beta", "alpha", "gamma"])
    expect(result.map((entry) => entry.groupLabel)).toEqual([undefined, undefined, undefined])
  })

  test("keeps project group entries in sidebar group order", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "project",
    })

    const result = flattenPawworkSessionSections(sections)

    expect(result.map((entry) => entry.item.id)).toEqual(["alpha", "beta", "gamma"])
    expect(result.map((entry) => entry.groupKey)).toEqual(["pawwork", "pawwork", "research"])
    expect(result.map((entry) => entry.groupLabel)).toEqual(["pawwork", "pawwork", "research"])
  })
})

describe("findPawworkSessionNavigationTarget", () => {
  test("wraps previous and next through sidebar order", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: ["beta"],
      sortMode: "time",
    })

    expect(
      findPawworkSessionNavigationTarget({
        sections,
        currentSessionID: "beta",
        offset: 1,
      })?.item.id,
    ).toBe("alpha")

    expect(
      findPawworkSessionNavigationTarget({
        sections,
        currentSessionID: "beta",
        offset: -1,
      })?.item.id,
    ).toBe("gamma")
  })

  test("returns the project group label for grouped targets", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "project",
    })

    const result = findPawworkSessionNavigationTarget({
      sections,
      currentSessionID: "beta",
      offset: 1,
    })

    expect(result?.item.id).toBe("gamma")
    expect(result?.groupKey).toBe("research")
    expect(result?.groupLabel).toBe("research")
  })

  test("anchors unread navigation on the full sidebar order", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "time",
    })

    const next = findPawworkSessionNavigationTarget({
      sections,
      currentSessionID: "beta",
      offset: 1,
      include: (item) => item.id !== "beta",
    })

    const previous = findPawworkSessionNavigationTarget({
      sections,
      currentSessionID: "beta",
      offset: -1,
      include: (item) => item.id !== "beta",
    })

    expect(next?.item.id).toBe("gamma")
    expect(previous?.item.id).toBe("alpha")
  })

  test("uses first or last eligible session when the current session is not in the eligible list", () => {
    const sections = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "time",
    })

    expect(
      findPawworkSessionNavigationTarget({
        sections,
        currentSessionID: "missing",
        offset: 1,
      })?.item.id,
    ).toBe("alpha")

    expect(
      findPawworkSessionNavigationTarget({
        sections,
        currentSessionID: "missing",
        offset: -1,
      })?.item.id,
    ).toBe("gamma")
  })
})

describe("reorderPawworkPinnedByVisible", () => {
  test("moves a session from recent into pinned at a specific visible index", () => {
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["beta"],
      visiblePinnedIDs: ["beta"],
      sourceID: "gamma",
      targetVisibleIndex: 0,
    })

    expect(result).toEqual(["gamma", "beta"])
  })

  test("removes duplicates when reordering inside pinned", () => {
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["alpha", "beta", "gamma"],
      visiblePinnedIDs: ["alpha", "beta", "gamma"],
      sourceID: "gamma",
      targetVisibleIndex: 1,
    })

    expect(result).toEqual(["alpha", "gamma", "beta"])
  })

  test("preserves un-loaded pinned IDs in their raw positions when reordering visible ones", () => {
    // hidden_a and hidden_b are pinned but not rendered (e.g. not in the session window).
    // The user sees [V1, V2, V3] and drags V3 to the top of the visible list.
    // hidden_a should stay at raw index 0, hidden_b should stay between V1 and V2.
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["hidden_a", "V1", "hidden_b", "V2", "V3"],
      visiblePinnedIDs: ["V1", "V2", "V3"],
      sourceID: "V3",
      targetVisibleIndex: 0,
    })

    expect(result).toEqual(["hidden_a", "V3", "hidden_b", "V1", "V2"])
  })

  test("moving a visible row DOWN across a hidden anchor keeps the hidden ID at its raw index", () => {
    // pinnedIDs = [V1, V2, hidden_a, V3]: hidden_a sits between V2 and V3 in raw.
    // User drags V1 down to visible position 2 → visible order becomes [V2, V3, V1].
    // Naive iteration cursors would shift hidden_a earlier; the algorithm must
    // pin it to raw index 2 regardless of which direction the source moved.
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["V1", "V2", "hidden_a", "V3"],
      visiblePinnedIDs: ["V1", "V2", "V3"],
      sourceID: "V1",
      targetVisibleIndex: 2,
    })

    expect(result).toEqual(["V2", "V3", "hidden_a", "V1"])
  })

  test("cross-zone insert lands between visible neighbours, not after a trailing hidden anchor", () => {
    // hidden_a sits AFTER V1 in raw; user drops gamma after V1 visually.
    // The new entry should land immediately after V1, even though hidden_a
    // would be the next raw entry if we walked the array linearly.
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["V1", "hidden_a"],
      visiblePinnedIDs: ["V1"],
      sourceID: "gamma",
      targetVisibleIndex: 1,
    })

    expect(result).toEqual(["V1", "gamma", "hidden_a"])
  })

  test("cross-zone insert with hidden BEFORE visible appends after the visible tail", () => {
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["hidden_a", "V1"],
      visiblePinnedIDs: ["V1"],
      sourceID: "gamma",
      targetVisibleIndex: 1,
    })

    expect(result).toEqual(["hidden_a", "V1", "gamma"])
  })

  test("cross-zone insert at the top of visible lands before the first visible neighbour", () => {
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["hidden_a", "V1", "V2"],
      visiblePinnedIDs: ["V1", "V2"],
      sourceID: "gamma",
      targetVisibleIndex: 0,
    })

    expect(result).toEqual(["hidden_a", "gamma", "V1", "V2"])
  })

  test("clamps an out-of-range visible target index to the visible list bounds", () => {
    const result = reorderPawworkPinnedByVisible({
      pinnedIDs: ["V1", "V2"],
      visiblePinnedIDs: ["V1", "V2"],
      sourceID: "gamma",
      targetVisibleIndex: 99,
    })

    expect(result).toEqual(["V1", "V2", "gamma"])
  })
})

describe("unpinPawworkSession", () => {
  test("removes the source from the pinned array, leaving the rest intact", () => {
    const result = unpinPawworkSession({
      pinnedIDs: ["alpha", "beta", "gamma"],
      sourceID: "beta",
    })

    expect(result).toEqual(["alpha", "gamma"])
  })

  test("is a no-op when the source is not in the pinned array", () => {
    const result = unpinPawworkSession({
      pinnedIDs: ["alpha", "beta"],
      sourceID: "missing",
    })

    expect(result).toEqual(["alpha", "beta"])
  })

  test("returns the same array identity when the source is absent (no spurious setStore writes)", () => {
    const pinnedIDs = ["alpha", "beta"]
    const result = unpinPawworkSession({ pinnedIDs, sourceID: "missing" })

    expect(result).toBe(pinnedIDs)
  })
})
