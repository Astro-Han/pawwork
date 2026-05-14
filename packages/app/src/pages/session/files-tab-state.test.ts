import { describe, expect, test } from "bun:test"
import { deriveArtifactFiles } from "./files-tab-state"

describe("files tab state", () => {
  test("maps cumulative artifact history into Files-tab entries", () => {
    const files = deriveArtifactFiles("/Users/yuhan/PawWork", [
      { file: "report.docx", kind: "added" },
      { file: "notes.md", kind: "modified" },
    ] as any)

    expect(files.map((item) => item.path)).toEqual([
      "/Users/yuhan/PawWork/report.docx",
      "/Users/yuhan/PawWork/notes.md",
    ])
  })
})
