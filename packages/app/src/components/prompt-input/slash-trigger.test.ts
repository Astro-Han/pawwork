import { describe, expect, test } from "bun:test"
import { matchSlashTrigger } from "./slash-trigger"

describe("matchSlashTrigger", () => {
  describe("fires", () => {
    const cases: { label: string; before: string; query: string; offset: number }[] = [
      { label: "at start", before: "/sum", query: "sum", offset: 0 },
      { label: "bare slash at start", before: "/", query: "", offset: 0 },
      { label: "after a space", before: "please /sum", query: "sum", offset: 7 },
      { label: "after a newline", before: "line one\n/sum", query: "sum", offset: 9 },
      { label: "after a Han char", before: "请/总结", query: "总结", offset: 1 },
      { label: "after a Hiragana char", before: "あ/sum", query: "sum", offset: 1 },
      { label: "after a Katakana char", before: "ア/sum", query: "sum", offset: 1 },
      { label: "after a Hangul char", before: "가/sum", query: "sum", offset: 1 },
      { label: "empty query mid-text", before: "hello /", query: "", offset: 6 },
    ]
    for (const c of cases) {
      test(c.label, () => {
        const result = matchSlashTrigger(c.before)
        expect(result).toEqual({ query: c.query, offset: c.offset })
      })
    }
  })

  describe("does not fire", () => {
    const negatives: { label: string; before: string }[] = [
      { label: "inside a path token", before: "foo/bar" },
      { label: "after a trailing path slash", before: "/usr/" },
      { label: "url scheme", before: "http://" },
      { label: "url with host", before: "https://example" },
      { label: "a fraction", before: "2/3" },
      { label: "another fraction", before: "3/4" },
      { label: "after an ASCII word char", before: "foo/sum" },
      { label: "after a digit", before: "v2/sum" },
      { label: "after a colon", before: "key:/value" },
    ]
    for (const c of negatives) {
      test(c.label, () => {
        expect(matchSlashTrigger(c.before)).toBeNull()
      })
    }
  })

  test("matches the last slash run when several are present", () => {
    // "a/b " ended the first token; the trigger keys off the space before "/c".
    expect(matchSlashTrigger("a/b /c")).toEqual({ query: "c", offset: 4 })
  })
})
