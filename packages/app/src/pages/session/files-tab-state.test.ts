import { describe, expect, test } from "bun:test"
import { deriveArtifactFiles, normalizeArtifactPathKey } from "./files-tab-state"

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

  test("normalizeArtifactPathKey collapses mixed Windows slashes so map lookups match", () => {
    // deriveArtifactFiles always joins with `/`, so locally-built paths look
    // like `C:\repo/src/a.ts` while server-side openPath often arrives as
    // `C:\repo\src\a.ts`. Both must hash to the same key so the per-file
    // diff stats render on Windows; otherwise the row silently loses +N -N.
    const local = "C:\\repo/src/a.ts"
    const server = "C:\\repo\\src\\a.ts"
    expect(normalizeArtifactPathKey(local)).toBe("C:/repo/src/a.ts")
    expect(normalizeArtifactPathKey(local)).toBe(normalizeArtifactPathKey(server))
    // POSIX paths are unchanged so Mac/Linux behaviour stays identical.
    expect(normalizeArtifactPathKey("/Users/yuhan/PawWork/report.docx")).toBe(
      "/Users/yuhan/PawWork/report.docx",
    )
  })
})
