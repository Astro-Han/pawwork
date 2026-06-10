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

  test("registers managed attachment saving through preload, renderer, and main IPC", () => {
    expect(mainIpc).toContain('"save-attachment-file"')
    expect(mainIpc).toContain("ArrayBuffer.isView")
    expect(preload).toContain('"save-attachment-file"')
    expect(preloadTypes).toContain("saveAttachmentFile")
    expect(renderer).toContain("saveAttachmentFile")
  })
})
