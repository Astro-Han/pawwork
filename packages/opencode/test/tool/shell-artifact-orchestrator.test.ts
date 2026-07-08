import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { orchestrateArtifacts, type ArtifactDeps } from "../../src/tool/shell-artifact-orchestrator"
import { isLikelyWriteCommand } from "../../src/tool/shell-write-heuristic"
import { hasOfficeGenerator, nonOfficeGeneratorText, officeOutputPaths } from "../../src/tool/shell-office-artifacts"
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
  hasGeneratorFn?: (command: string) => boolean
  sideEffectFn?: (command: string) => string
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
    hasOfficeGenerator: opts.hasGeneratorFn ?? (() => false),
    sideEffectCommand: opts.sideEffectFn ?? ((command) => command),
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
      hasOfficeGenerator: () => false,
      sideEffectCommand: (command) => command,
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
  // isLikelyWriteCommand + officeOutputPaths (not mocks). A real `-o <office file>`
  // generator with no declared expected_outputs is tracked as an exact target — so it
  // is captured without a cwd scan (immune to a nested/overflowing directory) and,
  // critically, does NOT get a false uncaptured marker. Replaces the OfficeCLI E2E
  // coverage for the office output path.
  test("real -o office generator, no declared outputs → captures exact path, no cwd scan, no uncaptured", async () => {
    const file = np("artifacts/deck.pptx")
    const command = "uv run python scripts/svg_to_pptx.py deck -o artifacts/deck.pptx"
    expect(isLikelyWriteCommand(command)).toBe(true)
    expect(officeOutputPaths(command)).toEqual(["artifacts/deck.pptx"])

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      hasGeneratorFn: hasOfficeGenerator,
      sideEffectFn: nonOfficeGeneratorText,
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

    expect(harness.discoverCalls).toBe(0) // exact target → no best-effort cwd scan
    expect(harness.uncaptured).toHaveLength(0) // the deliverable was captured, not uncaptured
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true, exists: true, binary: true })
  })

  // A python .save("out.docx") generator (no -o flag) — the documented docx/xlsx
  // pattern — is still recognized as an exact output and captured.
  test("real .save() office generator, no -o flag → captures exact path, no uncaptured", async () => {
    const file = np("out.docx")
    const command = `uv run python -c "from docx import Document; d=Document(); d.save('out.docx')"`
    expect(isLikelyWriteCommand(command)).toBe(true)
    expect(officeOutputPaths(command)).toEqual(["out.docx"])

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      hasGeneratorFn: hasOfficeGenerator,
      sideEffectFn: nonOfficeGeneratorText,
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

    expect(harness.discoverCalls).toBe(0)
    expect(harness.uncaptured).toHaveLength(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    expect((result.metadata as any).artifacts).toBeArrayOfSize(1)
  })

  // A chained side effect alongside an exact office output: the -o file is captured,
  // but the trailing `echo ... > notes.txt` write is not, so the turn must still be
  // flagged uncaptured. Guards against the parsed-output path silently swallowing
  // side-effect visibility.
  test("exact -o output plus a chained non-office write → captures the office file AND marks uncaptured", async () => {
    const file = np("report.docx")
    const command = "uv run python build.py -o report.docx && echo notes > notes.txt"
    expect(officeOutputPaths(command)).toEqual(["report.docx"])
    // stripping the generator leaves the redirect, which reads as a write
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(true)

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      hasGeneratorFn: hasOfficeGenerator,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [], // the cwd scan finds no office side-effect files
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

    expect(harness.discoverCalls).toBeGreaterThan(0) // side-effect scan ran
    expect(harness.uncaptured).toHaveLength(1) // notes.txt write flagged
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file) // the office deliverable is still captured
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true })
  })

  // A native office generator that names NO output on the command line — its python
  // code calls doc.save("out.docx") inside a script file the parser can't see — must
  // still have its deliverable captured by the cwd backstop, and must NOT be flagged
  // uncaptured (the scan caught it, so nothing was lost). Guards the backstop against
  // regressing to "exact-output-or-nothing" for script-file generators.
  test("office generator with no command-visible output → cwd scan captures it, no uncaptured", async () => {
    const file = np("/tmp/work/out.docx")
    const command = "uv run python build_docx.py"
    expect(officeOutputPaths(command)).toEqual([]) // no -o, no inline .save
    expect(hasOfficeGenerator(command)).toBe(true)
    // stripping the generator leaves nothing, so it is not a "non-office side effect"
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(false)

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      hasGeneratorFn: hasOfficeGenerator,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [file],
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

    expect(harness.discoverCalls).toBeGreaterThan(0) // backstop scanned for the internal save
    expect(harness.uncaptured).toHaveLength(0) // captured, not lost
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true, exists: true })
  })

  // A dynamic -o value (an unexpanded shell variable) is NOT tracked verbatim — the
  // literal `$OUT.docx` would never match the real file. With no parsed exact output,
  // the generator falls back to the cwd scan, which captures the real report.docx.
  test("dynamic -o output path → not tracked verbatim; cwd scan captures the real file", async () => {
    const real = np("/tmp/work/report.docx")
    const command = 'OUT=report; uv run python build.py -o "$OUT.docx"'
    expect(officeOutputPaths(command)).toEqual([]) // $OUT.docx dropped as non-static
    expect(hasOfficeGenerator(command)).toBe(true)

    const harness = build({
      states: { [real]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      hasGeneratorFn: hasOfficeGenerator,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [real],
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

    expect(harness.discoverCalls).toBeGreaterThan(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(real) // the real file, not the phantom $OUT.docx
    expect(harness.uncaptured).toHaveLength(0)
  })
})
