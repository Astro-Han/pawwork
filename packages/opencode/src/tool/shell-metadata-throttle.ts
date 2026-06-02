import { Duration, Effect, Schedule, Semaphore, type Scope } from "effect"

export interface MetadataThrottleOptions {
  intervalMillis: number
  byteThreshold: number
  snapshot: () => string
  emit: (output: string) => Effect.Effect<void>
}

export interface MetadataThrottle {
  onChunk: (size: number) => Effect.Effect<void>
  flush: (reason: "spill" | "final") => Effect.Effect<void>
}

// Coalesces the shell tool's per-chunk metadata pushes. Without this, every
// decoded chunk fires a full part update + message.part.updated event, which is
// the dominant per-call cost for chatty commands. Emissions run through a single
// serialized channel so the timer fiber and the stream consumer never interleave
// writes — each emit ships the full preview, so an out-of-order write could let a
// stale preview overwrite a newer one downstream.
export const makeMetadataThrottle = (
  options: MetadataThrottleOptions,
): Effect.Effect<MetadataThrottle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    let dirty = false
    let bytesSinceFlush = 0
    let firstFlushed = false

    const emit = (force: boolean) =>
      lock.withPermits(1)(
        Effect.suspend(() => {
          if (!dirty && !force) return Effect.void
          const output = options.snapshot()
          // Clear before awaiting emit so chunks arriving mid-emit stay marked
          // dirty for the next flush instead of being silently dropped.
          dirty = false
          bytesSinceFlush = 0
          return options.emit(output)
        }),
      )

    const onChunk = (size: number) =>
      Effect.suspend(() => {
        dirty = true
        bytesSinceFlush += size
        // First non-empty chunk is visible immediately: downstream consumers
        // (e.g. the abort-on-output test path) rely on seeing it synchronously.
        if (!firstFlushed) {
          firstFlushed = true
          return emit(true)
        }
        if (bytesSinceFlush >= options.byteThreshold) return emit(true)
        return Effect.void
      })

    // "spill" forces an emit even under the byte threshold (output just crossed
    // to a tempfile); "final" is dirty-gated so it only pushes a pending tail.
    const flush = (reason: "spill" | "final") => emit(reason === "spill")

    yield* emit(false).pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(options.intervalMillis))),
      Effect.delay(Duration.millis(options.intervalMillis)),
      Effect.forkScoped,
    )

    return { onChunk, flush }
  })
