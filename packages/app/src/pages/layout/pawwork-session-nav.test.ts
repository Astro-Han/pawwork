import { describe, expect, test } from "bun:test"
import {
  buildPawworkSessionSections,
  findPawworkSessionNavigationTarget,
  flattenPawworkSessionSections,
  movePawworkSession,
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

describe("movePawworkSession", () => {
  test("moves a session from recent into pinned at a specific index", () => {
    const result = movePawworkSession({
      pinnedIDs: ["beta"],
      visibleUnpinnedIDs: ["alpha", "gamma"],
      sourceID: "gamma",
      targetSection: "pinned",
      targetIndex: 0,
    })

    expect(result).toEqual(["gamma", "beta"])
  })

  test("removes duplicates when reordering inside pinned", () => {
    const result = movePawworkSession({
      pinnedIDs: ["alpha", "beta", "gamma"],
      visibleUnpinnedIDs: [],
      sourceID: "gamma",
      targetSection: "pinned",
      targetIndex: 1,
    })

    expect(result).toEqual(["alpha", "gamma", "beta"])
  })
})
