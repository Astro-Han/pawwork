import { describe, expect, test } from "bun:test"
import {
  buildPawworkSessionSections,
  movePawworkSession,
  type PawworkSessionItem,
} from "./pawwork-session-nav"

const sessions: PawworkSessionItem[] = [
  {
    id: "beta",
    title: "Release notes",
    directory: "/repo",
    projectLabel: "pawwork",
    created: 200,
  },
  {
    id: "gamma",
    title: "OpenCLI comparison",
    directory: "/repo",
    projectLabel: "research",
    created: 100,
  },
  {
    id: "alpha",
    title: "Q2 narrative",
    directory: "/repo",
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
      currentSessionID: "alpha",
    })

    expect(result.pinned.map((item) => item.id)).toEqual(["beta"])
    expect(result.recent.map((item) => item.id)).toEqual(["alpha", "gamma"])
  })

  test("groups unpinned sessions by project when sort mode is project", () => {
    const result = buildPawworkSessionSections({
      sessions,
      pinnedIDs: [],
      sortMode: "project",
      currentSessionID: "alpha",
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
