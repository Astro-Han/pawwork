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

const successfulCallRecord = (
  url: string,
  recoverFiredFor: string[] = [],
): SessionDiagnostics.ToolCallRecord => ({
  sessionID,
  parentID,
  tool: "webfetch",
  inputHash: inputHashFor({ url }),
  targetHash: targetHashFor(url),
  metadata: {
    diagnostics: {
      loop: {
        inputHash: inputHashFor({ url }),
        targetHash: targetHashFor(url),
        outcome: "success",
        targetRepeatCount: 1,
        loopRecoverFiredFor: recoverFiredFor.length ? recoverFiredFor : undefined,
      },
    },
  },
})

describe("SessionDiagnostics.deriveParentLoopState", () => {
  test("keeps success and failure counts in separate signature buckets", () => {
    const url = "https://x.com/a"
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: [successfulCallRecord(url), successfulCallRecord(url)],
      errorRecords: [failingErrorRecord(url)],
      syntheticBlockSigKeys: [],
      parentID,
    })

    const successKey = `success:target:webfetch:${targetHashFor(url)}`
    const failureKey = `failure:target:webfetch:${targetHashFor(url)}`
    expect(state.signatures[successKey]?.completedCount).toBe(2)
    expect(state.signatures[failureKey]?.completedCount).toBe(1)
  })

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
    const sigKey = `failure:target:webfetch:${targetHashFor(url)}`
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
    const sigKey = `failure:input:webfetch:${inputHashFor({ url })}`
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
    const sigKey = `failure:target:webfetch:${targetHashFor(url)}`
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: [failingErrorRecord(url)],
      syntheticBlockSigKeys: [sigKey],
      parentID,
    })
    expect(state.signatures[sigKey]?.blockEmitted).toBe(true)
  })
})

describe("SessionDiagnostics.queryGateAction", () => {
  test("blocks the 4th successful occurrence after a 3rd-occurrence reminder", () => {
    const url = "https://x.com/a"
    const sigKey = `success:target:webfetch:${targetHashFor(url)}`
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: [
        successfulCallRecord(url),
        successfulCallRecord(url),
        successfulCallRecord(url, [sigKey]),
      ],
      errorRecords: [],
      syntheticBlockSigKeys: [],
      parentID,
    })

    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "success",
    })

    expect(decision.action).toBe("block")
    if (decision.action === "block") {
      expect(decision.kind).toBe("target")
      expect(decision.completedCount).toBe(3)
      expect(decision.nextOccurrenceCount).toBe(4)
    }
  })

  test("stops the 5th successful occurrence after quarantine", () => {
    const url = "https://x.com/a"
    const sigKey = `success:target:webfetch:${targetHashFor(url)}`
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: [
        successfulCallRecord(url),
        successfulCallRecord(url),
        successfulCallRecord(url, [sigKey]),
      ],
      errorRecords: [],
      syntheticBlockSigKeys: [sigKey],
      parentID,
    })

    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "success",
    })

    expect(decision.action).toBe("stop")
    if (decision.action === "stop") expect(decision.nextOccurrenceCount).toBe(5)
  })

  test("chooses stop over block across success and failure decisions", () => {
    const successStop = {
      action: "stop",
      sigKey: "success:input:webfetch:aaa",
      outcome: "success",
      kind: "input",
      completedCount: 3,
      nextOccurrenceCount: 5,
    } satisfies SessionDiagnostics.GateDecision
    const failureBlock = {
      action: "block",
      sigKey: "failure:input:webfetch:aaa",
      outcome: "failure",
      kind: "input",
      completedCount: 3,
      completedFailures: 3,
      nextOccurrenceCount: 4,
    } satisfies SessionDiagnostics.GateDecision

    expect(SessionDiagnostics.chooseGateDecision(failureBlock, successStop)).toBe(successStop)
    expect(SessionDiagnostics.chooseGateDecision(successStop, failureBlock)).toBe(successStop)
  })

  test("chooses failure block over success block when neither outcome stops", () => {
    const successBlock = {
      action: "block",
      sigKey: "success:input:webfetch:aaa",
      outcome: "success",
      kind: "input",
      completedCount: 3,
      nextOccurrenceCount: 4,
    } satisfies SessionDiagnostics.GateDecision
    const failureBlock = {
      action: "block",
      sigKey: "failure:input:webfetch:aaa",
      outcome: "failure",
      kind: "input",
      completedCount: 3,
      completedFailures: 3,
      nextOccurrenceCount: 4,
    } satisfies SessionDiagnostics.GateDecision

    expect(SessionDiagnostics.chooseGateDecision(failureBlock, successBlock)).toBe(failureBlock)
  })

  test("does not block same-step parallel successful repeats before the model can react", () => {
    const url = "https://x.com/a"
    const sigKey = `success:target:webfetch:${targetHashFor(url)}`
    const records = [
      successfulCallRecord(url),
      successfulCallRecord(url),
      successfulCallRecord(url, [sigKey]),
    ].map((record) => ({
      ...record,
      metadata: {
        diagnostics: {
          loop: {
            ...record.metadata.diagnostics?.loop,
            stepIndex: 1,
          },
        },
      },
    }))
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: records,
      errorRecords: [],
      syntheticBlockSigKeys: [],
      parentID,
      currentStepIndex: 1,
    })

    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "success",
    })

    expect(decision.action).toBe("observe")
  })

  test("does not block when current step index is unavailable", () => {
    const url = "https://x.com/a"
    const sigKey = `success:target:webfetch:${targetHashFor(url)}`
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: [
        successfulCallRecord(url),
        successfulCallRecord(url),
        successfulCallRecord(url, [sigKey]),
      ],
      errorRecords: [],
      syntheticBlockSigKeys: [],
      parentID,
      currentStepIndex: 1,
    })

    const decision = SessionDiagnostics.queryGateAction({
      parentLoopState: state,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "success",
    })

    expect(decision.action).toBe("observe")
  })

  test("fallback-target successful repeats gate by exact signature only", () => {
    const input = { payload: "same opaque request" }
    let records: SessionDiagnostics.ToolCallRecord[] = []
    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolCall({
        records,
        sessionID,
        parentID,
        tool: "unknown_mcp",
        input,
        agent: "build",
        modelID: "model" as any,
        providerID: "provider" as any,
      })
      records = [...records, observed.record]
    }

    const inputHash = inputHashFor(input)
    const inputSigKey = `success:input:unknown_mcp:${inputHash}`
    const state = SessionDiagnostics.deriveParentLoopState({
      successRecords: records,
      errorRecords: [],
      syntheticBlockSigKeys: [],
      parentID,
    })

    expect(state.signatures[inputSigKey]?.completedCount).toBe(3)
    expect(Object.keys(state.signatures).some((key) => key.startsWith("success:target:unknown_mcp:"))).toBe(false)
  })

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

  test("observe before the failure reminder threshold", () => {
    const url = "https://x.com/a"
    const records = [
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
    expect(decision.action).toBe("observe")
  })

  test("block at >= 5 with target recover emitted and budget unspent", () => {
    const url = "https://x.com/a"
    const sigKey = `failure:target:webfetch:${targetHashFor(url)}`
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
    const sigKey = `failure:target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
      failingErrorRecord(url),
      failingErrorRecord(url),
    ]
    const state = SessionDiagnostics.deriveParentLoopState({
      errorRecords: records,
      syntheticBlockSigKeys: ["failure:input:other:zzz"],
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
    const sigKey = `failure:target:webfetch:${targetHashFor(url)}`
    const records = [
      failingErrorRecord(url),
      failingErrorRecord(url),
      failingErrorRecord(url, [sigKey]),
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
    const sigKey = `failure:input:webfetch:${inputHash}`
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
