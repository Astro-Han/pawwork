import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { fileNotePath, readPageNote, readWorkspaceNotes, savePageNote, saveWorkspaceNotes } from "./workspace-notes"

test("keeps general memory and file notes separate and linked to the selected file", () => {
  const root = mkdtempSync(join(tmpdir(), "pawwork-notes-"))
  const outside = mkdtempSync(join(tmpdir(), "pawwork-outside-"))
  try {
    const source = join(root, "drawing.pdf")
    writeFileSync(source, "%PDF-sample")
    mkdirSync(join(root, "sub"))
    const outsideFile = join(outside, "outside.pdf")
    writeFileSync(outsideFile, "%PDF-outside")
    saveWorkspaceNotes(root, "memory", "Remember this", source)
    const path = saveWorkspaceNotes(root, "file", "# Important points\n\nCheck dimension A", source)
    expect(readWorkspaceNotes(root, source)).toMatchObject({ memory: "Remember this", source: "drawing.pdf", fileNotes: "# Important points\n\nCheck dimension A" })
    expect(readFileSync(path, "utf8")).toContain("Check dimension A")
    expect(readFileSync(path, "utf8")).toContain('<!-- PawWork source: "drawing.pdf" -->')
    expect(fileNotePath(root, source).path).toBe(path)
    const pagePath = savePageNote(root, source, 3, "Check valve at page 3")
    expect(readPageNote(root, source, 3)).toBe("Check valve at page 3")
    expect(readFileSync(pagePath, "utf8")).toContain('"drawing.pdf"#3')
    expect(() => savePageNote(root, source, 0, "wrong")).toThrow("Invalid PDF page")
    expect(() => saveWorkspaceNotes(root, "file", "wrong", outsideFile)).toThrow("inside the allowed folder")
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
