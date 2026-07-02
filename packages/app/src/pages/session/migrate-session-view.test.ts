import { describe, expect, test } from "bun:test"

import { migrateSessionView, readLegacyState, resolveActiveCandidate, type LegacyEntry } from "./migrate-session-view"

const legacyEntry = (input: Partial<LegacyEntry>): LegacyEntry => ({
  sessionViewRaw: undefined,
  rawOpenShellTabs: undefined,
  migratedSidePanelTab: undefined,
  reviewInSessionTabs: false,
  contextInSessionTabs: false,
  sessionTabsRaw: undefined,
  ...input,
})

describe("readLegacyState", () => {
  test("key set is union of sessionView and sessionTabs keys", () => {
    const legacy = readLegacyState({ a: { scroll: {} } }, { a: { all: [] }, b: { all: ["context"] } })
    expect([...legacy.keys()].sort()).toEqual(["a", "b"])
  })

  test("detects context in sessionTabs.all or active", () => {
    const legacy = readLegacyState(
      { a: { scroll: {} }, b: { scroll: {} } },
      { a: { all: ["context", "file://x"] }, b: { all: ["file://y"], active: "context" } },
    )
    expect(legacy.get("a")?.contextInSessionTabs).toBe(true)
    expect(legacy.get("b")?.contextInSessionTabs).toBe(true)
  })

  test("coerces legacy 'changes' sidePanelTab in phase 1", () => {
    const legacy = readLegacyState({ a: { scroll: {}, sidePanelTab: "changes" } }, {})
    expect(legacy.get("a")?.migratedSidePanelTab).toBe("review")
  })

  test("tolerates non-object inputs", () => {
    expect(readLegacyState(undefined, undefined).size).toBe(0)
    expect(readLegacyState(null, "bogus").size).toBe(0)
  })
})

describe("resolveActiveCandidate", () => {
  test("prefers context from legacy session tabs", () => {
    expect(resolveActiveCandidate(legacyEntry({ migratedSidePanelTab: "review", sessionTabsRaw: { active: "context" } })))
      .toBe("context")
  })

  test("maps legacy review inner tabs before stored side panel tab", () => {
    expect(resolveActiveCandidate(legacyEntry({ migratedSidePanelTab: "status", sessionTabsRaw: { active: "changes" } })))
      .toBe("review")
    expect(resolveActiveCandidate(legacyEntry({ migratedSidePanelTab: "status", sessionTabsRaw: { active: "review" } })))
      .toBe("review")
  })

  test("falls back to stored side panel tab before inferred review presence", () => {
    expect(resolveActiveCandidate(legacyEntry({ migratedSidePanelTab: "status", reviewInSessionTabs: true }))).toBe(
      "status",
    )
    expect(resolveActiveCandidate(legacyEntry({ reviewInSessionTabs: true }))).toBe("review")
  })
})

describe("migrateSessionView", () => {
  test("new session without data creates status only shell state", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, {})
    expect(out.sessionView).toEqual({ a: { scroll: {}, openShellTabs: ["status"], sidePanelTab: "status" } })
    expect(out.changed).toBe(true)
  })

  test("legacy changes tab opens review", () => {
    const out = migrateSessionView({ a: { scroll: {}, sidePanelTab: "changes" } }, {})
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
  })

  test("legacy sessionTabs changes opens review shell and review inner tab", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, { a: { all: ["changes", "file://x"], active: "changes" } })
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: "review" })
  })

  test("legacy sessionTabs review active opens review shell without sidePanelTab", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, { a: { all: [], active: "review" } })
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
    expect((out.sessionTabs as any).a).toEqual({ all: [], active: "review" })
  })

  test("legacy active file tab opens review shell without sidePanelTab", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, { a: { all: ["file://x"], active: "file://x" } })
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: "file://x" })
  })

  test("preserves existing openShellTabs and absorbs sessionTabs active context", () => {
    const out = migrateSessionView(
      { a: { scroll: {}, openShellTabs: ["status", "review"], sidePanelTab: "review" } },
      { a: { all: ["file://x"], active: "context" } },
    )
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review", "context"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("context")
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: undefined })
  })

  test("orphan sessionTabs context without sessionView creates shell", () => {
    const out = migrateSessionView({}, { a: { all: ["context", "file://y"], active: "context" } })
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review", "context"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("context")
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://y"], active: undefined })
  })

  test("filters non-file sessionTabs entries and keeps valid active file", () => {
    const out = migrateSessionView(
      { a: { scroll: {}, sidePanelTab: "review" } },
      { a: { all: ["review", "file://x", "context"], active: "file://x" } },
    )
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: "file://x" })
  })

  test("preserves review as the active inner tab while cleaning legacy shell tabs", () => {
    const out = migrateSessionView(
      { a: { scroll: {}, sidePanelTab: "review" } },
      { a: { all: ["file://x", "context"], active: "review" } },
    )
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review", "context"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: "review" })
  })

  test("clears orphan active when all is clean but active is non-file", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, { a: { all: ["file://x"], active: "bogus" } })
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: undefined })
  })

  test("clears orphan active file when it is missing from all", () => {
    const out = migrateSessionView({ a: { scroll: {} } }, { a: { all: ["file://x"], active: "file://missing" } })
    expect((out.sessionTabs as any).a).toEqual({ all: ["file://x"], active: undefined })
    expect(out.changed).toBe(true)
  })

  test("normalizes damaged openShellTabs and drops legacy files", () => {
    const out = migrateSessionView(
      { a: { scroll: {}, openShellTabs: ["review", "status", "files", "files"], sidePanelTab: "review" } },
      {},
    )
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("review")
  })

  test("keeps valid openShellTabs but resets invalid sidePanelTab", () => {
    const out = migrateSessionView(
      { a: { scroll: {}, openShellTabs: ["status", "review"], sidePanelTab: "bogus" } },
      {},
    )
    expect((out.sessionView as any).a.openShellTabs).toEqual(["status", "review"])
    expect((out.sessionView as any).a.sidePanelTab).toBe("status")
    expect(out.changed).toBe(true)
  })

  test("is idempotent on migrated data", () => {
    const first = migrateSessionView(
      { a: { scroll: {}, openShellTabs: ["status", "review"], sidePanelTab: "review" } },
      {},
    )
    const second = migrateSessionView(first.sessionView, first.sessionTabs)
    expect(second.sessionView).toEqual(first.sessionView)
    expect(second.sessionTabs).toEqual(first.sessionTabs)
    expect(second.changed).toBe(false)
  })
})
