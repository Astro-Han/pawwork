import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mainIpc = readFileSync(resolve(import.meta.dir, "ipc.ts"), "utf8")
const preload = readFileSync(resolve(import.meta.dir, "../preload/index.ts"), "utf8")
const preloadTypes = readFileSync(resolve(import.meta.dir, "../preload/types.ts"), "utf8")
const renderer = readFileSync(resolve(import.meta.dir, "../renderer/index.tsx"), "utf8")

describe("attachment IPC source contract", () => {
  test("exposes Electron file path recovery to the sandboxed renderer", () => {
    expect(preload).toContain("webUtils")
    expect(preload).toContain("webUtils.getPathForFile")
    expect(preloadTypes).toContain("filePathForBrowserFile")
    expect(renderer).toContain("filePathForBrowserFile")
  })

  test("approves drag-dropped file paths so thumbnails can load", () => {
    // Picker and save-attachment approve their paths in the main process, but a
    // drag-drop resolves its path in the preload via webUtils — the preload must
    // report it for approval or read-file-data-url refuses the thumbnail read.
    expect(mainIpc).toContain('"approve-attachment-path"')
    expect(preload).toContain('"approve-attachment-path"')
    // Approval must complete before the path is handed to the renderer, or the
    // first preview read races the allowlist insert.
    expect(preload).toMatch(/await ipcRenderer\.invoke\("approve-attachment-path"/)
    expect(renderer).toMatch(/await window\.api\.filePathForBrowserFile/)
  })

  test("file path recovery degrades to an explicit null, never a falsy string", () => {
    // The app-side Platform contract is Promise<string | null>: synthetic
    // browser Files have no path, and an approval failure must not leak an
    // unapproved path. Both degrade to null so callers fall back to the
    // save-attachment copy route.
    expect(preloadTypes).toMatch(/filePathForBrowserFile.*Promise<string \| null>/)
    expect(preload).toMatch(/if \(!path\) return null/)
    expect(preload).toMatch(/approve-attachment-path"[\s\S]{0,200}?catch[\s\S]{0,80}?null/)
  })

  test("registers managed attachment saving through preload, renderer, and main IPC", () => {
    expect(mainIpc).toContain('"save-attachment-file"')
    expect(mainIpc).toContain("ArrayBuffer.isView")
    expect(preload).toContain('"save-attachment-file"')
    expect(preloadTypes).toContain("saveAttachmentFile")
    expect(renderer).toContain("saveAttachmentFile")
  })
})
