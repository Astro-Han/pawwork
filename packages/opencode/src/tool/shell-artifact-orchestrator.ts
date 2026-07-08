import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import type * as Tool from "./tool"
import { sameTrackedState, type TrackedOutputState, type OutputDiscovery } from "./shell-output-capture"
import type { RecordWriteInput, RecordUncapturedInput } from "../session/turn-change"

type ToolResultLike = {
  title: string
  metadata: Record<string, unknown>
  output: string
}

type TrackedOutput = {
  path: string
  before: TrackedOutputState
}

// All Effect-returning deps share one requirement type parameter `DepR`.
// This makes service requirements (InstanceState, ChildProcessSpawner,
// TurnChange.Service, etc.) bubble up to the orchestrator's return type
// instead of being swallowed by `any` — wiring the orchestrator into a
// runtime that lacks one of those services becomes a compile error, not
// a runtime crash.
export type ArtifactDeps<DepR = never> = {
  resolveExecutionPath: (raw: string, root: string, shell: string) => Effect.Effect<string, never, DepR>
  assertExternalDirectory: (
    ctx: Tool.Context,
    filepath: string,
    opts: { kind: "file" },
  ) => Effect.Effect<string | undefined, never, DepR>
  readTrackedState: (file: string) => Effect.Effect<TrackedOutputState, never, DepR>
  discoverOfficeOutputs: (cwd: string, projectRoot: string) => Effect.Effect<OutputDiscovery, never, DepR>
  isLikelyWriteCommand: (command: string) => boolean
  parseOfficeOutputs: (command: string) => readonly string[]
  hasOfficeGenerator: (command: string) => boolean
  sideEffectCommand: (command: string) => string
  recordWrite: (input: RecordWriteInput) => Effect.Effect<void, never, DepR>
  recordUncaptured: (input: RecordUncapturedInput) => Effect.Effect<void, never, DepR>
}

export type ArtifactInput = {
  ctx: Tool.Context
  cwd: string
  directory: string
  shell: string
  command: string
  expectedOutputs: readonly string[]
}

export type ArtifactRunner<R> = () => Effect.Effect<ToolResultLike, never, R>

export const orchestrateArtifacts = <RunR, DepR>(
  input: ArtifactInput,
  run: ArtifactRunner<RunR>,
  deps: ArtifactDeps<DepR>,
): Effect.Effect<ToolResultLike, never, RunR | DepR> =>
  Effect.gen(function* () {
    const { ctx, cwd, directory, shell, command, expectedOutputs } = input
    const hasMessage = !!ctx.messageID
    const declared = expectedOutputs ?? []
    const dedupeByNormalized = (
      items: ReadonlyArray<{ path: string; before: TrackedOutputState; normalized: string }>,
    ) => {
      const out = new Map<string, TrackedOutput>()
      for (const item of items) {
        if (out.has(item.normalized)) continue
        out.set(item.normalized, { path: item.path, before: item.before })
      }
      return Array.from(out.values())
    }

    const resolveTrackedInput = (rawPath: string) =>
      Effect.gen(function* () {
        const resolved = yield* deps.resolveExecutionPath(rawPath, cwd, shell)
        const normalized = AppFileSystem.normalizePath(resolved)
        const filepath = (yield* deps.assertExternalDirectory(ctx, normalized, { kind: "file" })) ?? normalized
        return {
          normalized: AppFileSystem.normalizePath(filepath),
          path: filepath,
          before: yield* deps.readTrackedState(filepath),
        }
      })

    // Declared expected_outputs are exact and always shown. Office outputs parsed
    // from the command (an -o/--out flag or a python .save("out.docx") call) are also
    // exact — captured without a cwd scan, immune to a nested target or discovery
    // overflow — but, being inferred rather than declared, are shown only when they
    // changed, like a discovered artifact.
    const parsed = declared.length === 0 && hasMessage ? deps.parseOfficeOutputs(command) : []

    const declaredTracked = dedupeByNormalized(
      yield* Effect.forEach(declared, resolveTrackedInput, { concurrency: 4 }),
    )
    const parsedTracked = dedupeByNormalized(
      yield* Effect.forEach(parsed, resolveTrackedInput, { concurrency: 4 }),
    )

    // The cwd backstop scans for two distinct kinds of undeclared write, and each is
    // treated differently:
    //
    //  - `sideEffectWrite`: a non-office write that remains after the office generators
    //    are stripped (`... -o a.docx && echo x > notes.txt` leaves `echo x > notes.txt`;
    //    a pure `... -o a.docx` leaves nothing). This scans AND flags the turn
    //    uncaptured, because the office-only scan can't capture such a file.
    //  - `generatorWithoutExactOutput`: a native office generator that named no output
    //    on the command line (a script whose python code calls `doc.save(...)` internally,
    //    invisible to the parser). This scans to CAPTURE the deliverable, but does not
    //    flag uncaptured on its own — if the scan finds the file it is captured, not lost.
    //
    // A generator that DID name an exact output (parsed non-empty) is captured precisely
    // and skips the scan entirely, staying immune to a nested or overflowing cwd.
    const sideEffectWrite =
      declared.length === 0 && hasMessage && deps.isLikelyWriteCommand(deps.sideEffectCommand(command))
    const generatorWithoutExactOutput =
      declared.length === 0 && hasMessage && parsed.length === 0 && deps.hasOfficeGenerator(command)
    const shouldAutoDiscover = sideEffectWrite || generatorWithoutExactOutput

    const autoDiscoveredBefore = shouldAutoDiscover
      ? yield* Effect.gen(function* () {
          const discovered = yield* deps.discoverOfficeOutputs(cwd, directory)
          if (discovered.overflowed) return { outputs: [] as TrackedOutput[], overflowed: true as const }
          const outputs = yield* Effect.forEach(
            discovered.paths,
            (filepath) =>
              Effect.gen(function* () {
                return {
                  path: filepath,
                  before: yield* deps.readTrackedState(filepath),
                }
              }),
            { concurrency: 4 },
          )
          return { outputs: outputs as TrackedOutput[], overflowed: false as const }
        })
      : undefined

    const result = yield* run()

    // office-targeted outputs (parsed exact outputs + discovered files) are shown only
    // when changed; declared outputs are always shown.
    const declaredKeys = new Set(declaredTracked.map((item) => AppFileSystem.normalizePath(item.path)))
    const officeTracked = new Map<string, TrackedOutput>()
    for (const item of parsedTracked) {
      officeTracked.set(AppFileSystem.normalizePath(item.path), { path: item.path, before: item.before })
    }

    let discoveryOverflowed = false
    if (shouldAutoDiscover) {
      discoveryOverflowed = autoDiscoveredBefore?.overflowed ?? false
      if (!discoveryOverflowed) {
        for (const item of autoDiscoveredBefore?.outputs ?? []) {
          const normalized = AppFileSystem.normalizePath(item.path)
          if (declaredKeys.has(normalized) || officeTracked.has(normalized)) continue
          officeTracked.set(normalized, item)
        }
        const discoveredAfter = yield* deps.discoverOfficeOutputs(cwd, directory)
        discoveryOverflowed = discoveredAfter.overflowed
        if (!discoveryOverflowed) {
          for (const filepath of discoveredAfter.paths) {
            const normalized = AppFileSystem.normalizePath(filepath)
            if (declaredKeys.has(normalized) || officeTracked.has(normalized)) continue
            officeTracked.set(normalized, {
              path: filepath,
              before: { state: { exists: false }, comparable: true, kind: "missing" },
            })
          }
        }
      }
      // On overflow we keep whatever exact/parsed outputs we already have.
    }

    const buildArtifact = (tracked: TrackedOutput) =>
      Effect.gen(function* () {
        const after = yield* deps.readTrackedState(tracked.path)
        const changed =
          tracked.before.comparable && after.comparable && !sameTrackedState(tracked.before.state, after.state)
        if (changed) {
          yield* deps.recordWrite({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            path: tracked.path,
            before: tracked.before.state,
            after: after.state,
          })
        }
        return {
          path: tracked.path,
          exists: after.state.exists,
          changed,
          ...(after.kind === "directory" ? { directory: true } : {}),
          ...(after.state.binary && after.kind !== "directory" ? { binary: true } : {}),
          ...(after.state.large ? { large: true } : {}),
          ...(!tracked.before.comparable || !after.comparable
            ? {
                comparable: false,
                errorCode: tracked.before.errorCode ?? after.errorCode,
              }
            : {}),
        }
      })

    const declaredArtifacts = yield* Effect.forEach(declaredTracked, buildArtifact, { concurrency: 4 })
    const officeArtifacts = yield* Effect.forEach(Array.from(officeTracked.values()), buildArtifact, {
      concurrency: 4,
    })

    // Flag the turn uncaptured when a write escaped exact capture: a non-office side
    // effect (the cwd scan is office-only, so a plain `> notes.txt` is never captured),
    // or a discovery overflow that forced us to drop office captures. A generator whose
    // internal `.save(...)` the scan actually captured is NOT flagged — it was caught,
    // not lost.
    if (sideEffectWrite || discoveryOverflowed) {
      yield* deps.recordUncaptured({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
      })
    }

    const visibleArtifacts = [...declaredArtifacts, ...officeArtifacts.filter((item) => item.changed)]

    if (visibleArtifacts.length === 0) return result

    return {
      ...result,
      metadata: {
        ...result.metadata,
        artifacts: visibleArtifacts,
      },
    }
  })
