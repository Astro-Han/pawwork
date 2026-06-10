import { describe, expect, test } from "bun:test"
import { filterListItems } from "../src/hooks/filter-list-items"

describe("useFilteredList", () => {
  test("keeps skipped async results while filtering ordinary items", () => {
    type Item = { id: string; title: string; serverRanked?: boolean }
    const result = filterListItems<Item>(
      [
        { id: "command", title: "Open Settings" },
        { id: "file", title: "src/file-without-local-match.ts", serverRanked: true },
      ],
      "unlikely-query",
      ["title"],
      (item) => item.serverRanked === true,
    )

    expect(result.map((item) => item.id)).toEqual(["file"])
  })

  test("appends skipped results after ordinary fuzzy matches", () => {
    type Item = { id: string; title: string; serverRanked?: boolean }
    const result = filterListItems<Item>(
      [
        { id: "command", title: "Open Settings" },
        { id: "file", title: "src/file-without-local-match.ts", serverRanked: true },
      ],
      "Open",
      ["title"],
      (item) => item.serverRanked === true,
    )

    expect(result.map((item) => item.id)).toEqual(["command", "file"])
  })
})
