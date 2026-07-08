import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { orchestrateArtifacts, type ArtifactDeps } from "../../src/tool/shell-artifact-orchestrator"
import { isLikelyWriteCommand } from "../../src/tool/shell-write-heuristic"
import { officeOutputPaths } from "../../src/tool/shell-office-artifacts"
import type { TrackedOutputState, OutputDiscovery } from "../../src/tool/shell-output-capture"
import type { RecordWriteInput, RecordUncapturedInput } from "../../src/session/turn-change"
import { MessageID, SessionID } from "../../src/session/schema"

// Orchestrator internally feeds every path through AppFileSystem.normalizePath
// before calling deps.readTrackedState / building artifact.path. On Windows
// that rewrites "/tmp/work/foo" to "D:\\tmp\\work\\foo", so the mock state
// dictionary must be keyed by the platform-native form. np() is a no-op on
// POSIX, so the same test file works on every runner.
const np = (p: string) => AppFileSystem.normalizePath(p)

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
  isWrite?: boolean
  isWriteFn?: (command: string) => boolean
  parseFn?: (command: string) => readonly string[]
  discoverPaths?: string[]
  discoverOverflowed?: boolean
  discoverPathsAfter?: string[]
  discoverOverflowedAfter?: boolean
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
    isLikelyWriteCommand: opts.isWriteFn ?? (() => opts.isWrite ?? false),
    parseOfficeOutputs: opts.parseFn ?? (() => []),
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
    const file = np("/tmp/work/out.docx")
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
          command: "python build.py out.docx",
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
    const file = np("/tmp/work/same.docx")
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
          command: "python build.py same.docx",
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

  test("auto-discovery overflow with no captured items → recordUncaptured, no artifacts metadata", async () => {
    const harness = build({
      states: {},
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
      isLikelyWriteCommand: () => false,
      parseOfficeOutputs: () => [],
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
          command: "python build.py ordered.docx",
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
    const declared = np("/tmp/work/decl.docx")
    const harness = build({
      states: { [declared]: [stateMissing(), stateFile("d1")] },
      isWrite: true,
      discoverPaths: [np("/tmp/work/side.docx")],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command: "python build.py decl.docx",
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

  // Integration guard for the native office route: drives the REAL
  // isLikelyWriteCommand + officeOutputPaths (not mocks), so a real
  // `-o <office file>` generator with no declared expected_outputs is captured from
  // the explicit output path even when the cwd scan returns nothing (a nested
  // `artifacts/` target the scan misses). This replaces the OfficeCLI E2E coverage
  // for the office output path and guards the parsed-path-into-tracking fix.
  test("real -o office generator, no declared outputs, empty cwd scan → still captures explicit path", async () => {
    const file = np("artifacts/deck.pptx")
    const command = "uv run python scripts/svg_to_pptx.py deck -o artifacts/deck.pptx"
    expect(isLikelyWriteCommand(command)).toBe(true)
    expect(officeOutputPaths(command)).toEqual(["artifacts/deck.pptx"])

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      discoverPaths: [], // cwd scan finds nothing — capture must come from the -o path
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        {
          ctx,
          cwd: "/tmp/work",
          directory: "/tmp/work",
          shell: "/bin/bash",
          command,
          expectedOutputs: [],
        },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true, exists: true, binary: true })
  })
})
