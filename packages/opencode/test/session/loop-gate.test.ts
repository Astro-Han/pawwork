import { describe, expect, test } from "bun:test"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionDiagnostics } from "../../src/session/diagnostics"

const sessionID = SessionID.make("ses_test")
const parentID = MessageID.make("msg_user")

const inputHashFor = (input: unknown) => SessionDiagnostics.normalizeInput(input).hash
const targetHashFor = (url: string) => SessionDiagnostics.hash("url:" + SessionDiagnostics.hash(url))

const failingErrorRecord = (
  url: string,
  recoverFiredFor: string[] = [],
): SessionDiagnostics.ToolErrorRecord => ({
  sessionID,
  parentID,
  tool: "webfetch",
  inputHash: inputHashFor({ url }),
  targetHash: targetHashFor(url),
  errorFingerprint: SessionDiagnostics.errorFingerprint(new Error("404")),
  lastInput: { url },
  lastError: "404",
  metadata: {
    diagnostics: {
      loop: {
        errorFingerprint: SessionDiagnostics.errorFingerprint(new Error("404")),
        loopRecoverFiredFor: recoverFiredFor.length ? recoverFiredFor : undefined,
        loopLastInput: { url },
        loopLastError: "404",
      },
    },
  },
})

describe("SessionDiagnostics.deriveParentLoopState", () => {
  test("populates SignatureState.lastInput/lastError from latest matching record", () => {
    const url = "https://x.com/a"
    // Two distinct records; the second one's lastError must win — proves "latest", not
    // "first match in array order".
    const records = [failingErrorRecord(url), { ...failingErrorRecord(url), lastError: "500" }]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [],
      parentID,
    })
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    expect(state.signatures[sigKey]?.lastInput).toEqual({ url })
    expect(state.signatures[sigKey]?.lastError).toBe("500")
  })

  test("counts non-block records as completedFailures", () => {
    const url = "https://x.com/a"
    const records = [failingErrorRecord(url), failingErrorRecord(url)]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [],
      parentID,
    })
    const sigKey = `input:webfetch:${inputHashFor({ url })}`
    expect(state.signatures[sigKey]?.completedFailures).toBe(2)
  })

  test("autoResumeSpent flips when any synthetic block sigKey is present", () => {
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: [],
      syntheticBlockSigKeys: ["input:webfetch:abc"],
      parentID,
    })
    expect(state.autoResumeSpent).toBe(true)
  })

  test("blockEmitted set on the matched signature", () => {
    const url = "https://x.com/a"
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: [failingErrorRecord(url)],
      syntheticBlockSigKeys: [sigKey],
      parentID,
    })
    expect(state.signatures[sigKey]?.blockEmitted).toBe(true)
  })
})

describe("SessionDiagnostics.queryGateAction", () => {
  test("observe when no failures", () => {
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: [],
      syntheticBlockSigKeys: [],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url: "https://x.com/a" }),
      targetHash: targetHashFor("https://x.com/a"),
    })
    expect(decision.action).toBe("observe")
  })

  test("observe when failures < 5", () => {
    const url = "https://x.com/a"
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
      failingErrorRecord(url),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
    })
    expect(decision.action).toBe("observe")
  })

  test("block at >= 5 with target recover emitted and budget unspent", () => {
    const url = "https://x.com/a"
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
      failingErrorRecord(url),
      failingErrorRecord(url),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
    })
    expect(decision.action).toBe("block")
    if (decision.action === "block") {
      expect(decision.kind).toBe("target")
      expect(decision.completedFailures).toBe(5)
    }
  })

  test("stop when autoResumeSpent", () => {
    const url = "https://x.com/a"
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
      failingErrorRecord(url),
      failingErrorRecord(url),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: ["input:other:zzz"],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
    })
    expect(decision.action).toBe("stop")
  })

  test("stop when blockEmitted on this same signature", () => {
    const url = "https://x.com/a"
    const sigKey = `target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
      failingErrorRecord(url),
      failingErrorRecord(url),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [sigKey],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
    })
    expect(decision.action).toBe("stop")
  })

  test("only same_input matches when targetHash absent", () => {
    const inputHash = inputHashFor({ k: "v" })
    const sigKey = `input:webfetch:${inputHash}`
    const make = (recoverFiredFor: string[] = []): SessionDiagnostics.ToolErrorRecord => ({
      ...failingErrorRecord("u", recoverFiredFor),
      inputHash,
      targetHash: undefined,
      lastInput: { k: "v" },
    })
    const records: SessionDiagnostics.ToolErrorRecord[] = [
      make(),
      make(),
      make([sigKey]),
      make(),
      make(),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: [],
      parentID,
    })
    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash,
      targetHash: undefined,
    })
    expect(decision.action).toBe("block")
    if (decision.action === "block") expect(decision.kind).toBe("input")
  })
})
