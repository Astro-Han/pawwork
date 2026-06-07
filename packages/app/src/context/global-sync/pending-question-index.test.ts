import { describe, expect, test } from "bun:test"
import {
  type PendingQuestion,
  type PendingQuestionIndex,
  pendingRootSessionIDs,
  pendingSessionIDsForDirectory,
  reconcileDirectoryPending,
  removePendingQuestions,
  setPendingQuestionRoot,
  upsertPendingQuestion,
} from "./pending-question-index"

function question(input: {
  sessionID: string
  messageID: string
  callID: string
  partID?: string
  rootSessionID?: string
}): PendingQuestion {
  return {
    id: `${input.messageID}:${input.callID}`,
    sessionID: input.sessionID,
    questions: [{ question: "?" }],
    messageID: input.messageID,
    callID: input.callID,
    partID: input.partID ?? `prt_${input.callID}`,
    rootSessionID: input.rootSessionID,
  }
}

describe("upsertPendingQuestion", () => {
  test("returns true only on the first insert of an identity", () => {
    const index: PendingQuestionIndex = {}
    const q = question({ sessionID: "s1", messageID: "m1", callID: "c1" })
    expect(upsertPendingQuestion(index, "/dir", q)).toBe(true)
    expect(upsertPendingQuestion(index, "/dir", q)).toBe(false)
    expect(index["/dir"]["s1"]).toHaveLength(1)
  })

  test("re-upsert keeps an already-resolved root", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1", rootSessionID: "root" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    expect(index["/dir"]["s1"][0].rootSessionID).toBe("root")
  })
})

describe("setPendingQuestionRoot", () => {
  test("fills the root on an existing entry", () => {
    const index: PendingQuestionIndex = {}
    const q = question({ sessionID: "s1", messageID: "m1", callID: "c1" })
    upsertPendingQuestion(index, "/dir", q)
    setPendingQuestionRoot(index, "/dir", "s1", q.id, "root")
    expect(index["/dir"]["s1"][0].rootSessionID).toBe("root")
  })

  test("no-op when the entry retracted mid-walk", () => {
    const index: PendingQuestionIndex = {}
    expect(() => setPendingQuestionRoot(index, "/dir", "s1", "m1:c1", "root")).not.toThrow()
    expect(index["/dir"]).toBeUndefined()
  })
})

describe("removePendingQuestions", () => {
  test("by partID retracts one part, returns it", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1", partID: "p1" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m2", callID: "c2", partID: "p2" }))
    const removed = removePendingQuestions(index, { directory: "/dir", partID: "p1" })
    expect(removed.map((q) => q.partID)).toEqual(["p1"])
    expect(index["/dir"]["s1"]).toHaveLength(1)
  })

  test("by messageID sweeps every question in the message", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c2" }))
    removePendingQuestions(index, { directory: "/dir", messageID: "m1" })
    expect(index["/dir"]).toBeUndefined()
  })

  test("by directory + sessionID drops a deleted session", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s2", messageID: "m2", callID: "c2" }))
    removePendingQuestions(index, { directory: "/dir", sessionID: "s1" })
    expect(index["/dir"]["s1"]).toBeUndefined()
    expect(index["/dir"]["s2"]).toHaveLength(1)
  })

  test("without directory sweeps every project", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/a", question({ sessionID: "s1", messageID: "m1", callID: "c1", partID: "p" }))
    upsertPendingQuestion(index, "/b", question({ sessionID: "s2", messageID: "m2", callID: "c2", partID: "p" }))
    const removed = removePendingQuestions(index, { partID: "p" })
    expect(removed).toHaveLength(2)
    expect(index).toEqual({})
  })
})

describe("reconcileDirectoryPending", () => {
  test("prunes resolved questions and keeps survivors", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m2", callID: "c2" }))
    const dropped = reconcileDirectoryPending(index, "/dir", [question({ sessionID: "s1", messageID: "m1", callID: "c1" })])
    expect(dropped).toEqual(["m2:c2"])
    expect(index["/dir"]["s1"].map((q) => q.id)).toEqual(["m1:c1"])
  })

  test("carries forward a resolved root across reconcile", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1", rootSessionID: "root" }))
    reconcileDirectoryPending(index, "/dir", [question({ sessionID: "s1", messageID: "m1", callID: "c1" })])
    expect(index["/dir"]["s1"][0].rootSessionID).toBe("root")
  })

  test("empty snapshot clears the directory", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    reconcileDirectoryPending(index, "/dir", [])
    expect(index["/dir"]).toBeUndefined()
  })
})

describe("derivations", () => {
  test("pendingRootSessionIDs dedupes by root and falls back to ask session", () => {
    const index: PendingQuestionIndex = {}
    // two child agents under the same root → one badge unit
    upsertPendingQuestion(index, "/dir", question({ sessionID: "child-a", messageID: "m1", callID: "c1", rootSessionID: "root" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "child-b", messageID: "m2", callID: "c2", rootSessionID: "root" }))
    // unresolved → counts under its own ask session
    upsertPendingQuestion(index, "/other", question({ sessionID: "lonely", messageID: "m3", callID: "c3" }))
    expect(pendingRootSessionIDs(index)).toEqual(new Set(["root", "lonely"]))
  })

  test("pendingSessionIDsForDirectory lists asking sessions for trim preserve", () => {
    const index: PendingQuestionIndex = {}
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s1", messageID: "m1", callID: "c1" }))
    upsertPendingQuestion(index, "/dir", question({ sessionID: "s2", messageID: "m2", callID: "c2" }))
    expect(pendingSessionIDsForDirectory(index, "/dir")).toEqual(new Set(["s1", "s2"]))
    expect(pendingSessionIDsForDirectory(index, "/missing")).toEqual(new Set())
  })
})
