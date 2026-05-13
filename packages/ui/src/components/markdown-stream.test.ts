import { describe, expect, test } from "bun:test"
import { stream } from "./markdown-stream"

describe("markdown stream", () => {
  test("non-streaming returns one stable full block", () => {
    expect(stream("hello\n\nworld", false)).toEqual([
      { raw: "hello\n\nworld", src: "hello\n\nworld", mode: "full", stable: true },
    ])
  })

  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([
      { raw: "hello **world", src: "hello **world**", mode: "live", stable: false },
    ])
    expect(stream("say `code", true)).toEqual([
      { raw: "say `code", src: "say `code`", mode: "live", stable: false },
    ])
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live", stable: false },
    ])
  })

  test("splits an unfinished trailing code fence: head stable + code tail dirty", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "live", stable: true },
      { raw: "```ts\nconst x = 1", src: "```ts\nconst x = 1", mode: "live", stable: false },
    ])
  })

  test("keeps reference-style markdown as one dirty block (ambiguous boundaries)", () => {
    // refs() forces single-block path because `[label]: url` defs can be
    // resolved by inline tokens that appear earlier in the text — splitting
    // them off would orphan the link.
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
        stable: false,
      },
    ])
  })

  describe("dirty tail boundary (multi-token streaming)", () => {
    test("multi-paragraph streaming: prior paragraphs stable, last paragraph dirty", () => {
      // The last non-space token (the trailing paragraph) is dirty; everything
      // before it has stable token boundaries the lexer already closed.
      const result = stream("# Heading\n\nFirst paragraph.\n\nSecond para in", true)
      expect(result).toHaveLength(2)
      const [head, tail] = result
      expect(head!.stable).toBe(true)
      expect(head!.mode).toBe("live")
      expect(head!.raw).toBe("# Heading\n\nFirst paragraph.\n\n")
      expect(tail!.stable).toBe(false)
      expect(tail!.mode).toBe("live")
      expect(tail!.raw).toBe("Second para in")
    })

    test("single-token streaming (one paragraph only): single dirty block", () => {
      // Only one token in the stream — no stable head to split off. The whole
      // text is the dirty tail.
      const result = stream("just one paragraph still going", true)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        raw: "just one paragraph still going",
        src: "just one paragraph still going",
        mode: "live",
        stable: false,
      })
    })

    test("edge case: half-finished list — entire list is the dirty tail", () => {
      // A growing list (`- a\n- b\n- c`) is a single list token at the lexer
      // level. With a preceding paragraph, the paragraph is stable head and
      // the whole list is the dirty tail (last item still streaming).
      const result = stream("intro paragraph.\n\n- one\n- two\n- thr", true)
      expect(result).toHaveLength(2)
      const [head, tail] = result
      expect(head!.stable).toBe(true)
      expect(head!.raw).toBe("intro paragraph.\n\n")
      expect(tail!.stable).toBe(false)
      expect(tail!.raw).toBe("- one\n- two\n- thr")
    })

    test("edge case: half-finished link inside trailing paragraph — paragraph stays dirty tail", () => {
      // The incomplete link `[docs](https://…` is part of the last paragraph
      // token; healing strips it for rendering. The preceding paragraph is
      // stable.
      const result = stream("first stable line.\n\nsee [docs](https://example.com/gu", true)
      expect(result).toHaveLength(2)
      const [head, tail] = result
      expect(head!.stable).toBe(true)
      expect(head!.raw).toBe("first stable line.\n\n")
      expect(tail!.stable).toBe(false)
      expect(tail!.raw).toBe("see [docs](https://example.com/gu")
      // Healing still applies to the dirty tail src.
      expect(tail!.src).toBe("see docs")
    })

    test("edge case: unclosed trailing code block with preceding stable content", () => {
      // Re-statement of the existing open-fence split, but framed as an
      // edge case for the dirty-tail spec so the head/tail boundary contract
      // is explicit even when the tail is a code token.
      const result = stream("intro\n\nbody paragraph.\n\n```\nstill streaming", true)
      expect(result).toHaveLength(2)
      const [head, tail] = result
      expect(head!.stable).toBe(true)
      expect(head!.raw).toBe("intro\n\nbody paragraph.\n\n")
      expect(tail!.stable).toBe(false)
      expect(tail!.raw).toBe("```\nstill streaming")
    })
  })

  describe("stability contract across streaming progression", () => {
    test("stable head raw is invariant once a later token starts streaming", () => {
      // Snapshot the head when a second token first appears, then advance the
      // tail. The head's raw + src + mode + stable must not drift — this is
      // the property that lets the renderer skip morphdom on the head wrapper.
      const first = stream("para one.\n\nbody", true)
      const second = stream("para one.\n\nbody continued with more text", true)
      expect(first).toHaveLength(2)
      expect(second).toHaveLength(2)
      expect(first[0]).toEqual(second[0]!)
    })
  })
})
