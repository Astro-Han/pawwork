import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "vitest"
import { launchFileFromArgs, launchFolderFromArgs, launchWorkspaceFromArgs, validWorkspaceDirectory } from "./launch-workspace"

test("accepts only an existing absolute folder for a workspace shortcut", () => {
  const folder = mkdtempSync(join(tmpdir(), "pawwork-workspace-"))
  try {
    const file = join(folder, "note.txt")
    writeFileSync(file, "sample")
    expect(validWorkspaceDirectory(folder)).toBe(folder)
    expect(validWorkspaceDirectory(file)).toBeUndefined()
    expect(validWorkspaceDirectory("relative-folder")).toBeUndefined()
    expect(launchWorkspaceFromArgs(["pawwork", "--sidebar", "--workspace", folder])).toBe(folder)
    expect(launchWorkspaceFromArgs(["pawwork", "--workspace", file])).toBeUndefined()
    expect(launchFileFromArgs(["pawwork", "--note-file", file])).toBe(file)
    expect(launchFolderFromArgs(["pawwork", "--note-file", file])).toBe(folder)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
