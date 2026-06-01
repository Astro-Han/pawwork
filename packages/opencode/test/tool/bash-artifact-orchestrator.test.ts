import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { orchestrateArtifacts, type ArtifactDeps } from "../../src/tool/bash-artifact-orchestrator"
import type { TrackedOutputState, OutputDiscovery } from "../../src/tool/bash-output-capture"
import type { RecordWriteInput, RecordUncapturedInput } from "../../src/session/turn-change"
import { MessageID, SessionID } from "../../src/session/schema"

type ToolResult = { title: string; metadata: Record<string, unknown>; output: string }

const sessionID = SessionID.make("ses_test_orch")
const messageID = MessageID.make("msg_test_orch")

const ctx = {
  sessionID,
  messageID,
  callID: "call_test",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
} as any

function buildResult(): ToolResult {
  return {
    title: "test",
    metadata: { output: "ok", exit: 0, description: "test" },
    output: "ok",
  }
}

function stateMissing(): TrackedOutputState {
  return { state: { exists: false }, comparable: true, kind: "missing" }
}

function stateFile(hash: string): TrackedOutputState {
  return {
    state: { exists: true, restorable: false, hash, binary: true },
    comparable: true,
    kind: "file",
  }
}

type MockHarness = {
  deps: ArtifactDeps
  writes: RecordWriteInput[]
  uncaptured: RecordUncapturedInput[]
  discoverCalls: number
}

function build(opts: {
  states: Record<string, TrackedOutputState[]>
  officeTargets?: string[]
  isWrite?: boolean
  discoverPaths?: string[]
  discoverOverflowed?: boolean
  discoverPathsAfter?: string[]
  discoverOverflowedAfter?: boolean
  nonOfficeCommandText?: (cmd: string) => string
}): MockHarness {
  const writes: RecordWriteInput[] = []
  const uncaptured: RecordUncapturedInput[] = []
  let discoverCalls = 0
  const stateCounts = new Map<string, number>()

  const readTrackedState = (file: string) =>
    Effect.sync(() => {
      const seq = opts.states[file]
      const count = stateCounts.get(file) ?? 0
      stateCounts.set(file, count + 1)
      if (seq && seq[count]) return seq[count]
      if (seq && seq.length > 0) return seq[seq.length - 1]
      return stateMissing()
    })

  const discoverOfficeOutputs = (_cwd: string, _root: string): Effect.Effect<OutputDiscovery, never, never> =>
    Effect.sync(() => {
      discoverCalls++
      if (discoverCalls === 1) {
        return { paths: opts.discoverPaths ?? [], overflowed: opts.discoverOverflowed ?? false }
      }
      return {
        paths: opts.discoverPathsAfter ?? opts.discoverPaths ?? [],
        overflowed: opts.discoverOverflowedAfter ?? opts.discoverOverflowed ?? false,
      }
    })

  const deps: ArtifactDeps = {
    resolveExecutionPath: (raw, _root, _shell) => Effect.succeed(raw),
    assertExternalDirectory: (_ctx, filepath, _opts) => Effect.succeed(filepath),
    readTrackedState,
    discoverOfficeOutputs,
    officeCliTargets: () => opts.officeTargets ?? [],
    nonOfficeCliCommandText: opts.nonOfficeCommandText ?? ((cmd) => cmd),
    isLikelyWriteCommand: () => opts.isWrite ?? false,
    recordWrite: (input) =>
      Effect.sync(() => {
        writes.push(input)
      }),
    recordUncaptured: (input) =>
      Effect.sync(() => {
        uncaptured.push(input)
      }),
  }

  return {
    deps,
    writes,
    uncaptured,
    get discoverCalls() {
      return discoverCalls
    },
  } as MockHarness
}

describe("orchestrateArtifacts", () => {
  test("declared expected_outputs, file changed → recordWrite + artifact visible", async () => {
    const file = "/tmp/work/out.docx"
    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "officecli docx create out.docx",
          expectedOutputs: [file],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true, exists: true })
  })

  test("declared expected_outputs, file unchanged → no recordWrite, artifact changed:false", async () => {
    const file = "/tmp/work/same.docx"
    const harness = build({
      states: { [file]: [stateFile("h1"), stateFile("h1")] },
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "officecli docx set same.docx --key x",
          expectedOutputs: [file],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(0)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: false, exists: true })
  })

  test("exact OfficeCLI target, no declared outputs, file changed → recordWrite + visible only when changed", async () => {
    const file = "/tmp/work/x.xlsx"
    const harness = build({
      states: { [file]: [stateMissing(), stateFile("hx")] },
      officeTargets: [file],
      isWrite: false,
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "officecli xlsx create x.xlsx",
          expectedOutputs: [],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0].changed).toBe(true)
  })

  test("auto-discovery overflow with no captured items → recordUncaptured, no artifacts metadata", async () => {
    const harness = build({
      states: {},
      officeTargets: [],
      isWrite: true,
      discoverPaths: [],
      discoverOverflowed: true,
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "node make-many-docs.js",
          expectedOutputs: [],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(0)
    expect(harness.uncaptured).toHaveLength(1)
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  test("read-only command → no orchestration noise, no recordUncaptured, no artifacts", async () => {
    const harness = build({
      states: {},
      officeTargets: [],
      isWrite: false, // isLikelyWriteCommand returns false
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "cat README.md",
          expectedOutputs: [],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(0)
    expect(harness.uncaptured).toHaveLength(0)
    expect(harness.discoverCalls).toBe(0)
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  test("before-snapshot precedes runner — protects against shell.env-style side-effect ordering regressions", async () => {
    const file = "/tmp/work/ordered.docx"
    const order: string[] = []
    const stateCounts = new Map<string, number>()
    const readTrackedState = (target: string) =>
      Effect.sync(() => {
        const count = stateCounts.get(target) ?? 0
        stateCounts.set(target, count + 1)
        order.push(`read:${count === 0 ? "before" : "after"}`)
        if (count === 0) return stateMissing()
        return stateFile("written")
      })

    const deps: ArtifactDeps = {
      resolveExecutionPath: (raw) => Effect.succeed(raw),
      assertExternalDirectory: (_ctx, fp) => Effect.succeed(fp),
      readTrackedState,
      discoverOfficeOutputs: () => Effect.succeed({ paths: [], overflowed: false }),
      officeCliTargets: () => [],
      nonOfficeCliCommandText: (c) => c,
      isLikelyWriteCommand: () => false,
      recordWrite: () => Effect.void,
      recordUncaptured: () => Effect.void,
    }

    await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "officecli docx create ordered.docx",
          expectedOutputs: [file],
        },
        () =>
          Effect.sync(() => {
            order.push("runner")
            return buildResult()
          }),
        deps,
      ),
    )

    const beforeIndex = order.indexOf("read:before")
    const runnerIndex = order.indexOf("runner")
    expect(beforeIndex).toBeGreaterThanOrEqual(0)
    expect(runnerIndex).toBeGreaterThan(beforeIndex)
  })

  test("expected_outputs present → only declared recorded; discoverOfficeOutputs is NOT called", async () => {
    const declared = "/tmp/work/decl.docx"
    const harness = build({
      states: { [declared]: [stateMissing(), stateFile("d1")] },
      officeTargets: ["/tmp/work/should-be-ignored.docx"], // would surface if expected_outputs were empty
      isWrite: true,
      discoverPaths: ["/tmp/work/side.docx"],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "officecli docx create decl.docx",
          expectedOutputs: [declared],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBe(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(declared)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0].path).toBe(declared)
  })
})
