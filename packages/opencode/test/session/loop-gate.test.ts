import { describe, expect, test } from "bun:test"
import { MessageID, SessionID } from "../../src/session/schema"
import { SessionDiagnostics } from "../../src/session/diagnostics"

const sessionID = SessionID.make("ses_test")
const parentID = MessageID.make("msg_user")

const inputHashFor = (input: unknown) => SessionDiagnostics.normalizeInput(input).hash
const targetHashFor = (url: string) => SessionDiagnostics.hash("url:" + SessionDiagnostics.hash(url))
const targetHashForInput = (tool: string, input: unknown) => {
  const target = SessionDiagnostics.targetSummary(tool, input)
  if (target.isFallback) throw new Error("expected recognized target")
  return SessionDiagnostics.hash(target.summary)
}

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

  test("does not gate successful repeats even when prior state would have blocked or stopped (#767)", () => {
    // Reproduces the false-positive from #767: in the broken pre-fix code, a parent
    // turn with 5 identical successful `bash` invocations and zero `part.type === "patch"`
    // parts (snapshot system silent) produced a same-input signature bucket with
    // completedCount=3 + recoverEmitted=true at call #4 (block) and completedCount=3 +
    // blockEmitted=true + autoResumeSpent=true at call #5 (stop). We hand-construct the
    // ParentLoopState shape that the pre-fix code would have built and assert observe
    // on both stages. Construction is direct to keep this test stable across the
    // upcoming deriveParentLoopState surface shrink (commit 3).
    const command = { command: "bun run typecheck" }
    const inputHash = inputHashFor(command)
    const inputSigKey = `success:input:bash:${inputHash}`

    const blockShape: SessionDiagnostics.SignatureState = {
      outcome: "success",
      kind: "input",
      completedCount: 3,
      recoverEmitted: true,
      blockEmitted: false,
    }
    const stopShape: SessionDiagnostics.SignatureState = {
      outcome: "success",
      kind: "input",
      completedCount: 3,
      recoverEmitted: true,
      blockEmitted: true,
    }

    const wouldHaveBlocked: SessionDiagnostics.ParentLoopState = {
      autoResumeSpent: false,
      signatures: { [inputSigKey]: blockShape },
    }
    const wouldHaveStopped: SessionDiagnostics.ParentLoopState = {
      autoResumeSpent: true,
      signatures: { [inputSigKey]: stopShape },
    }

    for (const state of [wouldHaveBlocked, wouldHaveStopped]) {
      const decision = SessionDiagnostics.queryGateAction({
        parentLoopState: state,
        tool: "bash",
        inputHash,
        targetHash: targetHashForInput("bash", command),
        outcome: "success",
      })
      expect(decision.action).toBe("observe")
    }
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

  test("preserves cross-step failure gate across mutationEpoch removal (#767)", () => {
    // Pin failure-side gate behavior so the upcoming mutationEpoch removal (commit 3)
    // and the wider success-gate teardown around it cannot drift the failure path.
    // The signature key is `failure:input|target:<tool>:<inputHash|targetHash>`
    // (diagnostics.ts:565-566); `errorFingerprint` is a record field but not part of
    // the signature key. Block requires `recoverEmitted === true`, set from a prior
    // record carrying the sigKey in `loopRecoverFiredFor`. The gate only counts
    // records from prior completed steps (`stepIndex < currentStepIndex`).
    const url = "https://x.com/a"
    const targetSigKey = `failure:target:webfetch:${targetHashFor(url)}`
    const inputSigKey = `failure:input:webfetch:${inputHashFor({ url })}`
    const withStep = (
      record: SessionDiagnostics.ToolErrorRecord,
      stepIndex: number,
    ): SessionDiagnostics.ToolErrorRecord => ({
      ...record,
      metadata: {
        diagnostics: {
          loop: {
            ...record.metadata.diagnostics?.loop,
            stepIndex,
          },
        },
      },
    })

    const priorRecords = [
      withStep(failingErrorRecord(url), 1),
      withStep(failingErrorRecord(url), 2),
      withStep(failingErrorRecord(url, [targetSigKey, inputSigKey]), 3),
    ]

    // currentStepIndex = 4 simulates the gate-eval moment of the fourth attempted
    // call, after three prior-step failures have completed and the recover reminder
    // has fired on the third.
    const blockState = SessionDiagnostics.deriveParentLoopState({
      errorRecords: priorRecords,
      syntheticBlockSigKeys: [],
      parentID,
      currentStepIndex: 4,
    })
    const blockDecision = SessionDiagnostics.queryGateAction({
      parentLoopState: blockState,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "failure",
    })
    expect(blockDecision.action).toBe("block")
    if (blockDecision.action === "block") {
      expect(blockDecision.kind).toBe("target")
      expect(blockDecision.completedCount).toBe(3)
      expect(blockDecision.nextOccurrenceCount).toBe(4)
    }

    // After the synthetic block records the sigKey, `autoResumeSpent` flips and the
    // next occurrence (#5) reaches stop.
    const stopState = SessionDiagnostics.deriveParentLoopState({
      errorRecords: priorRecords,
      syntheticBlockSigKeys: [targetSigKey],
      parentID,
      currentStepIndex: 4,
    })
    const stopDecision = SessionDiagnostics.queryGateAction({
      parentLoopState: stopState,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "failure",
    })
    expect(stopDecision.action).toBe("stop")

    // Negative control: a different inputHash + targetHash returns observe. This
    // proves the test is measuring signature aggregation, not just record count.
    const otherUrl = "https://x.com/b"
    const observeDecision = SessionDiagnostics.queryGateAction({
      parentLoopState: blockState,
      tool: "webfetch",
      inputHash: inputHashFor({ url: otherUrl }),
      targetHash: targetHashFor(otherUrl),
      outcome: "failure",
    })
    expect(observeDecision.action).toBe("observe")

    // Same-step parallel: a fourth record at stepIndex === currentStepIndex is
    // filtered out by `isFromPreviousStep`, so the gate sees only the original
    // three and the decision is unchanged. This guards against the test accidentally
    // measuring active-step behavior instead of cross-step gating.
    const sameStepState = SessionDiagnostics.deriveParentLoopState({
      errorRecords: [...priorRecords, withStep(failingErrorRecord(url, [targetSigKey, inputSigKey]), 4)],
      syntheticBlockSigKeys: [],
      parentID,
      currentStepIndex: 4,
    })
    const sameStepDecision = SessionDiagnostics.queryGateAction({
      parentLoopState: sameStepState,
      tool: "webfetch",
      inputHash: inputHashFor({ url }),
      targetHash: targetHashFor(url),
      outcome: "failure",
    })
    expect(sameStepDecision.action).toBe("block")
    if (sameStepDecision.action === "block") {
      expect(sameStepDecision.completedCount).toBe(3)
    }
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
