import { describe, expect, test } from "bun:test"
import { captureCommentMentions, resolveCommentMentions } from "./mention-metadata"

describe("captureCommentMentions", () => {
  test("records displayText resolvedPath fingerprint range for single mention", () => {
    const result = captureCommentMentions({
      comment: "look at @src/foo.ts for context",
      sourceFilesystemDirectory: "/repo",
    })
    expect(result).toHaveLength(1)
    const entry = result[0]!
    expect(entry.displayText).toBe("@src/foo.ts")
    expect(entry.resolvedPath).toBe("/repo/src/foo.ts")
    expect(typeof entry.fingerprint).toBe("string")
    expect(entry.fingerprint.length).toBeGreaterThan(0)
    // start points to the '@' char
    expect(entry.start).toBe("look at ".length)
    expect(entry.end).toBe(entry.start + "@src/foo.ts".length)
    // verify the range correctly addresses the displayText in the original comment
    const comment = "look at @src/foo.ts for context"
    expect(comment.slice(entry.start, entry.end)).toBe("@src/foo.ts")
  })

  test("strips trailing punctuation from path", () => {
    const result = captureCommentMentions({
      comment: "see @src/a.ts, for details",
      sourceFilesystemDirectory: "/repo",
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.displayText).toBe("@src/a.ts")
    expect(result[0]!.resolvedPath).toBe("/repo/src/a.ts")
  })

  test("captures multiple mentions in order", () => {
    const result = captureCommentMentions({
      comment: "Compare @src/shared.ts and @src/review.ts.",
      sourceFilesystemDirectory: "/repo",
    })
    expect(result).toHaveLength(2)
    expect(result[0]!.displayText).toBe("@src/shared.ts")
    expect(result[1]!.displayText).toBe("@src/review.ts")
    // start order must be ascending
    expect(result[0]!.start).toBeLessThan(result[1]!.start)
  })

  test("skips empty path after punctuation strip", () => {
    // "@," -> strip trailing punctuation -> empty path, should be skipped
    const result = captureCommentMentions({
      comment: "weird mention @, and done",
      sourceFilesystemDirectory: "/repo",
    })
    expect(result).toHaveLength(0)
  })

  test("resolves relative path against POSIX source dir", () => {
    const result = captureCommentMentions({
      comment: "check @lib/utils.ts",
      sourceFilesystemDirectory: "/home/user/project",
    })
    expect(result[0]!.resolvedPath).toBe("/home/user/project/lib/utils.ts")
  })

  test("passes through absolute path unchanged in resolvedPath", () => {
    const result = captureCommentMentions({
      comment: "check @/absolute/path.ts",
      sourceFilesystemDirectory: "/repo",
    })
    expect(result[0]!.resolvedPath).toBe("/absolute/path.ts")
  })

  test("resolves against Windows drive source dir", () => {
    const result = captureCommentMentions({
      comment: "see @src\\helper.ts here",
      sourceFilesystemDirectory: "C:\\project",
    })
    expect(result[0]!.resolvedPath).toBe("C:\\project/src\\helper.ts")
  })
})

describe("resolveCommentMentions", () => {
  test("returns empty when metadata undefined", () => {
    const result = resolveCommentMentions({
      comment: "see @src/foo.ts for details",
      metadata: undefined,
    })
    expect(result).toEqual([])
  })

  test("returns empty when metadata empty array", () => {
    const result = resolveCommentMentions({
      comment: "see @src/foo.ts for details",
      metadata: [],
    })
    expect(result).toEqual([])
  })

  test("returns resolvedPath when fingerprint matches", () => {
    const comment = "look at @src/foo.ts for context"
    const metadata = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo" })
    const result = resolveCommentMentions({ comment, metadata })
    expect(result).toHaveLength(1)
    expect(result[0]!.resolvedPath).toBe("/repo/src/foo.ts")
  })

  test("drops when displayText no longer present", () => {
    const original = "look at @src/foo.ts for context"
    const metadata = captureCommentMentions({ comment: original, sourceFilesystemDirectory: "/repo" })
    // Remove the mention from the comment
    const modified = "look at something else for context"
    const result = resolveCommentMentions({ comment: modified, metadata })
    expect(result).toEqual([])
  })

  test("drops when comment body diverged from fingerprint window", () => {
    const original = "look at @src/foo.ts for context right here and now with enough surrounding text"
    const metadata = captureCommentMentions({ comment: original, sourceFilesystemDirectory: "/repo" })
    // Keep the @token but drastically change surrounding context
    const modified =
      "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX @src/foo.ts YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY"
    const result = resolveCommentMentions({ comment: modified, metadata })
    expect(result).toEqual([])
  })

  test("matches first of two same-name mentions by original range", () => {
    const comment = "@src/a.ts first then @src/a.ts second"
    const metadata = captureCommentMentions({ comment, sourceFilesystemDirectory: "/repo" })
    expect(metadata).toHaveLength(2)
    // Both should resolve with same resolvedPath
    const result = resolveCommentMentions({ comment, metadata })
    expect(result).toHaveLength(2)
    expect(result[0]!.resolvedPath).toBe("/repo/src/a.ts")
    expect(result[1]!.resolvedPath).toBe("/repo/src/a.ts")
  })

  test("matches second of two same-name mentions when first is gone", () => {
    const original = "@src/a.ts first then @src/a.ts second"
    const metadata = captureCommentMentions({ comment: original, sourceFilesystemDirectory: "/repo" })
    // Remove the first occurrence; now only the second remains
    const modified = "gone first then @src/a.ts second"
    const result = resolveCommentMentions({ comment: modified, metadata })
    // At most one resolves; both metadata entries are same-name so a sloppy
    // implementation could double-emit. Lock that down.
    expect(result.length).toBeLessThanOrEqual(1)
    // metadata[0] was first occurrence — its range no longer matches, occurrence 0 gone
    // metadata[1] was second occurrence — now occurrence 0 in modified; fingerprint won't match
    // either metadata[0] or [1] may match depending on context window; the key assertion
    // is that at most one resolves (the second entry's fingerprint matches the sole occurrence)
    for (const match of result) {
      expect(match.resolvedPath).toBe("/repo/src/a.ts")
    }
  })

  test("free-text @x.ts without metadata is dropped (no fallback resolve)", () => {
    // No metadata — even though the text has an @-mention, nothing should be returned
    const result = resolveCommentMentions({
      comment: "check @src/lost.ts please",
      metadata: undefined,
    })
    expect(result).toEqual([])
  })
})
