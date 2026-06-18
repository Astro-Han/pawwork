import path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Context, Effect, Layer } from "effect"
import { makeRuntime } from "../effect/run-service"
import { isRecord } from "../util/record"

/**
 * Writes the user's picked model to the `recent` list in `state/model.json`, the
 * source `Provider.defaultModel()` reads when a prompt carries no explicit model.
 */
export namespace ModelState {
  export interface ModelRef {
    providerID: string
    modelID: string
  }

  export interface Interface {
    readonly recordRecent: (model: ModelRef) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ModelState") {}

  // Keep enough history that defaultModel() can fall through to an older choice
  // when the most-recent provider/model is no longer connected.
  export const MAX_RECENT = 50

  function isModelRef(x: unknown): x is ModelRef {
    return isRecord(x) && typeof x.providerID === "string" && typeof x.modelID === "string"
  }

  /**
   * Pure: compute the next model.json contents, promoting `model` to the front of
   * `recent` (deduped, capped) while preserving every other field (favorite,
   * variant, …) so a write here never clobbers what the rest of opencode owns.
   */
  export function applyRecent(current: unknown, model: ModelRef, max: number = MAX_RECENT): Record<string, unknown> {
    const base = isRecord(current) ? current : {}
    // Drop malformed old entries: defaultModel() skips them when reading, so
    // keeping them here would only waste a cap slot and push a still-valid older
    // model out of `recent`.
    const previous = (Array.isArray(base.recent) ? base.recent : []).filter(isModelRef)
    const deduped = previous.filter(
      (entry) => !(entry.providerID === model.providerID && entry.modelID === model.modelID),
    )
    const recent = [{ providerID: model.providerID, modelID: model.modelID }, ...deduped].slice(0, max)
    return { ...base, recent }
  }

  function isMissingFile(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false
    return (err as { reason?: { _tag?: string } }).reason?._tag === "NotFound"
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const flock = yield* EffectFlock.Service

      const recordRecent = Effect.fn("ModelState.recordRecent")(function* (model: ModelRef) {
        const file = path.join(Global.Path.state, "model.json")
        const tmp = `${file}.${process.pid}.tmp`

        yield* flock.withLock(
          Effect.gen(function* () {
            const current = yield* fs.readJson(file).pipe(
              Effect.catchIf(isMissingFile, () => Effect.succeed(undefined)),
            )

            yield* Effect.gen(function* () {
              yield* fs.writeWithDirs(tmp, JSON.stringify(applyRecent(current, model), null, 2))
              yield* fs.rename(tmp, file)
            }).pipe(Effect.ensuring(fs.remove(tmp).pipe(Effect.ignore)))
          }),
          `model-state:${file}`,
        ).pipe(
          // Malformed JSON is a defect in AppFileSystem.readJson; recording
          // recent stays best-effort for every read, lock, and write failure.
          Effect.catchCause(() => Effect.void),
        )
      })

      return Service.of({ recordRecent })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  /**
   * Best-effort, locked read-modify-write. Only a missing file (ENOENT) starts
   * from empty; any other read failure skips the write so sibling state (favorite,
   * variant, …) is never clobbered. The temp-file + rename keeps the unlocked
   * `defaultModel()` reader from ever seeing a half-written file, and failures
   * never reach the caller.
   */
  export async function recordRecent(model: ModelRef): Promise<void> {
    return runPromise((svc) => svc.recordRecent(model))
  }
}
