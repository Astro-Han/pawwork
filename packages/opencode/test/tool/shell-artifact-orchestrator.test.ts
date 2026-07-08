import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { orchestrateArtifacts, type ArtifactDeps } from "../../src/tool/shell-artifact-orchestrator"
import { isLikelyWriteCommand } from "../../src/tool/shell-write-heuristic"
import {
  hasOfficeOutputIntent,
  nonOfficeGeneratorText,
  officeOutputPaths,
} from "../../src/tool/shell-office-artifacts"
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
  intentFn?: (command: string) => boolean
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
    hasOfficeOutputIntent: opts.intentFn ?? (() => false),
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

  // Overflow WITH a parsed exact output: the exact `a.docx` is still captured, but the
  // dynamic sibling forced a scan that overflowed, so the turn is conservatively flagged
  // uncaptured (the office-only scan had to drop captures). Guards the overflow branch
  // when exact artifacts are also present.
  test("auto-discovery overflow with a parsed exact output → exact captured AND recordUncaptured", async () => {
    const exact = np("a.docx")
    const command = 'uv run python a.py -o a.docx && OUT=b uv run python b.py -o "$OUT.docx"'
    expect(officeOutputPaths(command)).toEqual(["a.docx"])
    expect(hasOfficeOutputIntent(command)).toBe(true)

    const harness = build({
      states: { [exact]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [],
      discoverOverflowed: true,
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(exact) // a.docx still captured despite overflow
    expect(harness.uncaptured).toHaveLength(1) // overflow → conservative uncaptured
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: exact, changed: true })
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
      hasOfficeOutputIntent: () => false,
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
      intentFn: hasOfficeOutputIntent,
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
      intentFn: hasOfficeOutputIntent,
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
      intentFn: hasOfficeOutputIntent,
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

  // A bare generator that names NO output on the command line — `uv run pytest`, or a
  // script whose ONLY write is an internal doc.save() the parser can't see — is
  // indistinguishable from a read-only invocation, so it does NOT trigger a speculative
  // cwd scan (which would false-flag read-only python in an office-heavy workspace).
  // Its deliverable, if any, is captured via the model-declared expected_outputs, the
  // instructed primary path. Guards against the fallback over-triggering on any python.
  test("bare generator with no named output → no scan, no uncaptured (relies on expected_outputs)", async () => {
    const command = "uv run pytest"
    expect(officeOutputPaths(command)).toEqual([])
    expect(hasOfficeOutputIntent(command)).toBe(false) // names no office output
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(false)

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [np("/tmp/work/ambient.docx")], // office clutter that must NOT be scanned
      discoverOverflowed: true,
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

    expect(harness.discoverCalls).toBe(0) // no speculative scan for a read-only invocation
    expect(harness.uncaptured).toHaveLength(0) // and therefore no false uncaptured
    expect(harness.writes).toHaveLength(0)
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  // A read-only python invocation that takes an office file as INPUT (no output flag)
  // must not be mistaken for a generator: no scan, no uncaptured.
  test("uv run python read_docx.py input.docx → no scan, no uncaptured", async () => {
    const command = "uv run python read_docx.py input.docx"
    expect(officeOutputPaths(command)).toEqual([])
    expect(hasOfficeOutputIntent(command)).toBe(false)

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [np("/tmp/work/other.xlsx")],
    })

    await Effect.runPromise(
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
    expect(harness.writes).toHaveLength(0)
  })

  // A dynamic -o value (an unexpanded shell variable) is NOT tracked verbatim — the
  // literal `$OUT.docx` would never match the real file. With no parsed exact output,
  // the generator falls back to the cwd scan, which captures the real report.docx.
  test("dynamic -o output path → not tracked verbatim; cwd scan captures the real file", async () => {
    const real = np("/tmp/work/report.docx")
    const command = 'OUT=report; uv run python build.py -o "$OUT.docx"'
    expect(officeOutputPaths(command)).toEqual([]) // $OUT.docx dropped as non-static
    expect(hasOfficeOutputIntent(command)).toBe(true)

    const harness = build({
      states: { [real]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
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

  // A dynamic office output the command clearly intended (`-o "$OUT.docx"`) that the cwd
  // scan does NOT find — it expanded outside cwd, or deeper than the scan reaches. With no
  // exact parse and no discovered file, the intended write must not silently vanish: the
  // turn is flagged uncaptured so the audit still records that a write was attempted.
  test("dynamic office output the scan can't find → recordUncaptured (write not silently lost)", async () => {
    const command = 'OUT=/tmp/elsewhere/report; uv run python build.py -o "$OUT.docx"'
    expect(officeOutputPaths(command)).toEqual([]) // dynamic value → no exact parse
    expect(hasOfficeOutputIntent(command)).toBe(true) // but intent is clear
    // stripping the office generator leaves no real non-office write
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(false)

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [], // scan finds nothing — the file landed outside cwd
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0) // intent scan ran
    expect(harness.writes).toHaveLength(0) // nothing captured
    expect(harness.uncaptured).toHaveLength(1) // but the intended write is flagged
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  // A command mixing an EXACT office output with a DYNAMIC one — the exact `a.docx` is
  // captured precisely, but `-o "$OUT.docx"` needs the cwd scan. The exact parse must not
  // suppress the dynamic scan: both deliverables are surfaced.
  test("mixed exact + dynamic office outputs → exact captured AND dynamic discovered", async () => {
    const exact = np("a.docx")
    const dyn = np("/tmp/work/b.docx")
    const command = 'uv run python a.py -o a.docx && OUT=b uv run python b.py -o "$OUT.docx"'
    expect(officeOutputPaths(command)).toEqual(["a.docx"]) // only the exact one parses
    expect(hasOfficeOutputIntent(command)).toBe(true) // dynamic b.docx still shows intent

    const harness = build({
      states: {
        [exact]: [stateMissing(), stateFile("h1")],
        [dyn]: [stateMissing(), stateFile("h2")],
      },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [dyn], // the scan finds the dynamic file
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0) // exact parse did NOT suppress the scan
    expect(harness.writes).toHaveLength(2) // both a.docx and b.docx captured
    expect(harness.writes.map((w) => w.path).sort()).toEqual([exact, dyn].sort())
    expect(harness.uncaptured).toHaveLength(0) // nothing lost
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(2)
  })

  // Same mix, but the dynamic file lands outside the scan. The exact `a.docx` changing must
  // NOT mask the lost dynamic `b.docx`: only a DISCOVERED change clears the dynamic flag, so
  // the turn is still marked uncaptured.
  test("mixed exact + dynamic, dynamic not found → exact captured AND uncaptured flagged", async () => {
    const exact = np("a.docx")
    const command = 'uv run python a.py -o a.docx && OUT=b uv run python b.py -o "$OUT.docx"'

    const harness = build({
      states: { [exact]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [], // dynamic b.docx landed outside the scan
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(exact) // a.docx still surfaced
    expect(harness.uncaptured).toHaveLength(1) // b.docx loss not masked by a.docx change
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
  })

  // `uv --directory work` chdirs into `work/` before running, so a relative `-o report.docx`
  // names `work/report.docx`, not `${cwd}/report.docx`. The parser must NOT track the phantom
  // original-cwd path; discovery captures the real nested file instead.
  test("uv --directory relative output → not tracked verbatim; cwd scan captures the nested file", async () => {
    const real = np("/tmp/work/work/report.docx")
    const command = "uv --directory work run python build.py -o report.docx"
    expect(officeOutputPaths(command)).toEqual([]) // relative under --directory chdir
    expect(hasOfficeOutputIntent(command)).toBe(true)

    const harness = build({
      states: { [real]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [real],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(real) // the real nested file, not the phantom cwd path
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: real, changed: true })
  })

  // A cwd-scoped .pdf output (`cd reports && ... -o report.pdf`) is neither exactly
  // capturable (cwd changed) nor discoverable (.pdf excluded from the scan), so it must be
  // flagged uncaptured rather than vanish silently from the audit.
  test("cwd-scoped .pdf output → recordUncaptured (explicit deliverable not silently lost)", async () => {
    const command = "cd reports && uv run python gen.py -o report.pdf"
    expect(officeOutputPaths(command)).toEqual([]) // relative under cd → not exact
    expect(hasOfficeOutputIntent(command)).toBe(true) // static office pdf → intent

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [], // .pdf is excluded from discovery, so nothing is found
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0)
    expect(harness.writes).toHaveLength(0)
    expect(harness.uncaptured).toHaveLength(1) // pdf loss flagged, not silent
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  // A generator wrapped across lines with a `\` shell continuation is ONE command; the
  // `-o` must not be orphaned into a headless segment. The office file is captured exactly.
  test("line-continued generator → captures the exact office output, no uncaptured", async () => {
    const file = np("report.docx")
    const command = "uv run python build.py \\\n-o report.docx"
    expect(officeOutputPaths(command)).toEqual(["report.docx"]) // continuation collapsed

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBe(0) // exact capture, no speculative scan
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file)
    expect(harness.uncaptured).toHaveLength(0)
    expect((result.metadata as any).artifacts).toBeArrayOfSize(1)
  })

  // A heredoc `.save()` under `uv --directory work`: the save call sits in a later split
  // segment that has no uv prefix, but the --directory chdir propagates to it, so the real
  // file is `work/out.docx`. The parser must not track the phantom cwd path; discovery
  // captures the nested file.
  test("uv --directory heredoc .save output → not tracked verbatim; cwd scan captures the nested file", async () => {
    const real = np("/tmp/work/work/out.docx")
    const command = "uv --directory work run python <<'PY'\ndoc.save('out.docx')\nPY"
    expect(officeOutputPaths(command)).toEqual([]) // heredoc .save inherits the --directory chdir
    expect(hasOfficeOutputIntent(command)).toBe(true)

    const harness = build({
      states: { [real]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [real],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(real)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: real, changed: true })
  })

  // After `cd reports`, a relative `-o report.docx` is relative to the shell's new
  // working directory, not the original execution cwd. The parser must not track the
  // original-cwd phantom; discovery captures the real nested file instead.
  test("cd before relative -o output path → cwd scan captures the real nested file", async () => {
    const real = np("/tmp/work/reports/report.docx")
    const command = "cd reports && uv run python build.py -o report.docx"
    expect(officeOutputPaths(command)).toEqual([])
    expect(hasOfficeOutputIntent(command)).toBe(true)

    const harness = build({
      states: { [real]: [stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [],
      discoverPathsAfter: [real],
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

    expect(harness.discoverCalls).toBe(2)
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(real)
    expect(harness.uncaptured).toHaveLength(0)
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: real, changed: true, exists: true })
  })

  // A generator with a non-office redirect and NO office output — the redirected file is
  // a real side effect the office-only scan can't capture, so it must be flagged
  // uncaptured (regression guard: dropping the whole generator segment would hide it).
  test("generator with a redirect side effect, no office output → recordUncaptured", async () => {
    const command = "uv run python analyze.py > results.txt"
    expect(officeOutputPaths(command)).toEqual([])
    expect(hasOfficeOutputIntent(command)).toBe(false)
    // the redirect survives the generator strip and reads as a write
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(true)

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.discoverCalls).toBeGreaterThan(0)
    expect(harness.uncaptured).toHaveLength(1) // results.txt flagged
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  // A non-office python write (`python setup.py build` — a write per the heuristic) that
  // names no office output must NOT be stripped from side-effect detection: its build/dist
  // changes still flag the turn uncaptured.
  test("python setup.py build (non-office write, no office output) → recordUncaptured", async () => {
    const command = "python setup.py build"
    expect(officeOutputPaths(command)).toEqual([])
    expect(hasOfficeOutputIntent(command)).toBe(false)
    // the segment is kept intact, so the heuristic still sees the setup.py write
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(true)

    const harness = build({
      states: {},
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.uncaptured).toHaveLength(1)
    expect((result.metadata as any).artifacts).toBeUndefined()
  })

  // An exact -o office output PLUS a same-segment redirect: the office file is captured
  // exactly, and the redirect side effect still marks the turn uncaptured.
  test("exact -o output plus same-segment redirect → captures office file AND marks uncaptured", async () => {
    const file = np("report.docx")
    const command = "uv run python build.py -o report.docx > log.txt"
    expect(officeOutputPaths(command)).toEqual(["report.docx"])
    expect(isLikelyWriteCommand(nonOfficeGeneratorText(command))).toBe(true) // `> log.txt` survives

    const harness = build({
      states: { [file]: [stateMissing(), stateFile("h1")] },
      isWriteFn: isLikelyWriteCommand,
      parseFn: officeOutputPaths,
      intentFn: hasOfficeOutputIntent,
      sideEffectFn: nonOfficeGeneratorText,
      discoverPaths: [],
    })

    const result = await Effect.runPromise(
      orchestrateArtifacts(
        { ctx, cwd: "/tmp/work", directory: "/tmp/work", shell: "/bin/bash", command, expectedOutputs: [] },
        () => Effect.succeed(buildResult()),
        harness.deps,
      ),
    )

    expect(harness.uncaptured).toHaveLength(1) // log.txt flagged
    expect(harness.writes).toHaveLength(1)
    expect(harness.writes[0].path).toBe(file) // report.docx captured exactly
    const artifacts = (result.metadata as any).artifacts
    expect(artifacts).toBeArrayOfSize(1)
    expect(artifacts[0]).toMatchObject({ path: file, changed: true })
  })
})
