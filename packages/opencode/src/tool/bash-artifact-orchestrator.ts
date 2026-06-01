import { Effect } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import type * as Tool from "./tool"
import { sameTrackedState, type TrackedOutputState, type OutputDiscovery } from "./bash-output-capture"
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
  officeCliTargets: (command: string) => readonly string[]
  nonOfficeCliCommandText: (command: string) => string
  isLikelyWriteCommand: (command: string) => boolean
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

    const trackedOutputs = dedupeByNormalized(
      yield* Effect.forEach(declared, resolveTrackedInput, { concurrency: 4 }),
    )

    const exactOfficeOutputs = dedupeByNormalized(
      yield* Effect.forEach(
        declared.length === 0 && hasMessage ? deps.officeCliTargets(command) : [],
        resolveTrackedInput,
        { concurrency: 4 },
      ),
    )

    const shouldAutoDiscover =
      declared.length === 0 &&
      hasMessage &&
      deps.isLikelyWriteCommand(
        exactOfficeOutputs.length ? deps.nonOfficeCliCommandText(command) : command,
      )

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

    let outputsToRecord: TrackedOutput[] = trackedOutputs
    let autoDiscovered = false
    let exactOfficeTargeted = false

    if (!outputsToRecord.length && exactOfficeOutputs.length) {
      outputsToRecord = exactOfficeOutputs
      exactOfficeTargeted = true
    }

    if (!trackedOutputs.length && shouldAutoDiscover) {
      autoDiscovered = true
      let overflowed = autoDiscoveredBefore?.overflowed ?? false
      const deduped = new Map<string, TrackedOutput>()
      for (const item of exactOfficeOutputs) {
        const normalized = AppFileSystem.normalizePath(item.path)
        if (deduped.has(normalized)) continue
        deduped.set(normalized, item)
      }
      if (!overflowed) {
        for (const item of autoDiscoveredBefore?.outputs ?? []) {
          const normalized = AppFileSystem.normalizePath(item.path)
          if (deduped.has(normalized)) continue
          deduped.set(normalized, item)
        }
        const discoveredAfter = yield* deps.discoverOfficeOutputs(cwd, directory)
        overflowed = discoveredAfter.overflowed
        if (!overflowed) {
          for (const filepath of discoveredAfter.paths) {
            const normalized = AppFileSystem.normalizePath(filepath)
            if (deduped.has(normalized)) continue
            deduped.set(normalized, {
              path: filepath,
              before: { state: { exists: false }, comparable: true, kind: "missing" },
            })
          }
        }
      }

      if (overflowed) {
        if (deduped.size > 0) {
          outputsToRecord = Array.from(deduped.values())
        } else {
          yield* deps.recordUncaptured({
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
          })
          return result
        }
      } else {
        outputsToRecord = Array.from(deduped.values())
      }
    }

    if (!outputsToRecord.length) {
      if (shouldAutoDiscover) {
        yield* deps.recordUncaptured({
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
        })
      }
      return result
    }

    const artifacts = yield* Effect.forEach(
      outputsToRecord,
      (tracked) =>
        Effect.gen(function* () {
          const after = yield* deps.readTrackedState(tracked.path)
          const changed =
            tracked.before.comparable &&
            after.comparable &&
            !sameTrackedState(tracked.before.state, after.state)
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
                  errorCode:
                    ("errorCode" in tracked.before ? tracked.before.errorCode : undefined) ??
                    ("errorCode" in after ? after.errorCode : undefined),
                }
              : {}),
          }
        }),
      { concurrency: 4 },
    )

    const visibleArtifacts =
      autoDiscovered || exactOfficeTargeted ? artifacts.filter((item) => item.changed) : artifacts

    if (autoDiscovered && visibleArtifacts.length === 0) {
      yield* deps.recordUncaptured({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
      })
      return result
    }

    if (exactOfficeTargeted && visibleArtifacts.length === 0) return result

    if (autoDiscovered) {
      yield* deps.recordUncaptured({
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
      })
    }

    return {
      ...result,
      metadata: {
        ...result.metadata,
        artifacts: visibleArtifacts,
      },
    }
  })
