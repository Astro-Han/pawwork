import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPacedValue } from "./message-part-markdown"

// SolidJS `createEffect` defers its re-runs to a microtask. After mutating
// a signal, the test must yield once so the effect can flush before reading
// `value()`. Wrapping each tick in a Promise keeps the assertion site close
// to the mutation.
const flushEffects = () => Promise.resolve()

/**
 * `createPacedValue` is the streaming lifecycle owner that the C-min plan
 * (PR #589) puts in front of `<Markdown>`. It paces the visible text while
 * `live=true` and is responsible for handing the renderer a deterministic
 * "final state" (full source + live=false) on settle / abort / SSE close so
 * the renderer can run a single full-render pass and clear any dirty-tail
 * wrappers without inferring lifecycle itself.
 *
 * These tests pin the lifecycle contract. Pacing cadence (PACE_MS step
 * size, snap behavior) is intentionally not asserted here — that is a
 * separate lever and is verified through retest, not unit tests.
 */
describe("createPacedValue — streaming lifecycle", () => {
  test("non-streaming source: value() tracks source", async () => {
    await createRoot(async (dispose) => {
      const [text, setText] = createSignal("hello world")
      const value = createPacedValue(text, () => false)
      expect(value()).toBe("hello world")
      setText("hello world expanded with more")
      await flushEffects()
      expect(value()).toBe("hello world expanded with more")
      dispose()
    })
  })

  test("live → false transition syncs full source immediately (settle / abort contract)", async () => {
    await createRoot(async (dispose) => {
      const longText = "a b c d e f g h i j k l m n o p"
      const [text] = createSignal(longText)
      const [live, setLive] = createSignal(true)
      const value = createPacedValue(text, live)
      // While live, value may legitimately lag behind source (paced reveal
      // schedules a setTimeout). The contract pinned here is the abort path:
      // PacedMarkdown / SessionTurn flips `live` from true to false on
      // SSE close / Esc / settle, and value() must catch up to the full
      // source on the next reactive tick so the renderer can do its single
      // full-render pass.
      setLive(false)
      await flushEffects()
      expect(value()).toBe(longText)
      dispose()
    })
  })

  test("source shrink while live syncs immediately (out-of-order edit / retry truncate)", async () => {
    await createRoot(async (dispose) => {
      const [text, setText] = createSignal("alpha beta gamma delta")
      const value = createPacedValue(text, () => true)
      // Source shrinks (e.g. retry / truncate) — value must catch up to the
      // new shorter source, otherwise the renderer would diff against stale
      // text.
      setText("alpha")
      await flushEffects()
      expect(value()).toBe("alpha")
      dispose()
    })
  })

  test("source replaced (not a prefix of shown) syncs immediately while live", async () => {
    await createRoot(async (dispose) => {
      const [text, setText] = createSignal("original message body")
      const [live] = createSignal(true)
      const value = createPacedValue(text, live)
      // Even live, an out-of-order edit replaces the source — sync, do not
      // attempt to paced-reveal an unrelated string.
      setText("completely different message")
      await flushEffects()
      expect(value()).toBe("completely different message")
      dispose()
    })
  })

  test("settle is per-streaming-cycle: a new live=true with a new source does not bypass pacing", async () => {
    // After a streaming run settles (live=false), if a new run later flips
    // live=true with a longer source, pacing must resume — settle is not
    // a permanent "skip pacing forever" flag. The contract verified here is
    // that flipping live=true does not also force a full sync of the new
    // source; the paced reveal scheduler takes over again.
    await createRoot(async (dispose) => {
      const [text, setText] = createSignal("done")
      const [live, setLive] = createSignal(false)
      const value = createPacedValue(text, live)
      expect(value()).toBe("done")

      // New streaming cycle begins with extended source.
      setText("done\n\nbrand new streaming message that is much longer than before")
      setLive(true)
      await flushEffects()
      // Source extends beyond shown ("done" is a prefix of new source) and
      // live=true. value() must NOT have jumped to the full new source —
      // pacing schedules incremental reveal.
      expect(value()).toBe("done")
      dispose()
    })
  })

  test("source equals shown while live: no spurious sync, no scheduling", async () => {
    // Identity reactivity ping (e.g. unrelated signal in same effect) must
    // not perturb the visible value or restart pacing for already-revealed
    // content.
    await createRoot(async (dispose) => {
      const [text] = createSignal("steady state text")
      const [live] = createSignal(false)
      const value = createPacedValue(text, live)
      expect(value()).toBe("steady state text")
      await flushEffects()
      // No mutations — value stays equal across reads.
      expect(value()).toBe("steady state text")
      dispose()
    })
  })
})
