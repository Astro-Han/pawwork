import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { expect, test, vi } from "vitest"
import { folderFromExplorerSnapshot, foregroundExplorerDirectory } from "./active-explorer"

const worker = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util")
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: worker.run }) }
})

test.skipIf(process.platform !== "win32")("reveals the sidebar after capturing Explorer, before folder lookup finishes", async () => {
  const stdout = new EventEmitter()
  let finish!: (result: { stdout: string }) => void
  const result = new Promise<{ stdout: string }>((resolve) => { finish = resolve })
  worker.run.mockReturnValueOnce(Object.assign(result, { child: { stdout } }))
  const reveal = vi.fn()
  const pending = foregroundExplorerDirectory(reveal)
  stdout.emit("data", "PAWWORK_FOREGROUND_")
  expect(reveal).not.toHaveBeenCalled()
  stdout.emit("data", "CAPTURED\n")
  expect(reveal).toHaveBeenCalledOnce()
  finish({ stdout: 'PAWWORK_FOREGROUND_CAPTURED\n{"title":"Home","tabs":[]}\n' })
  expect(await pending).toBeUndefined()
  expect(reveal).toHaveBeenCalledOnce()
})

test.skipIf(process.platform !== "win32")("a failed Explorer worker still reveals the sidebar", async () => {
  worker.run.mockReturnValueOnce(Object.assign(Promise.reject(new Error("worker failed")), { child: { stdout: new EventEmitter() } }))
  const reveal = vi.fn()
  expect(await foregroundExplorerDirectory(reveal)).toBeUndefined()
  expect(reveal).toHaveBeenCalledOnce()
})

test("uses the foreground Explorer tab instead of another open tab", () => {
  const root = mkdtempSync(join(tmpdir(), "pawwork-explorer-"))
  try {
    const gaurav = join(root, "Gaurav")
    const dist = join(root, "dist")
    mkdirSync(gaurav)
    mkdirSync(dist)
    const tabs = [{ name: "Gaurav", path: gaurav }, { name: "dist", path: dist }]
    expect(folderFromExplorerSnapshot({ title: "Gaurav and 1 more tab - File Explorer", tabs })).toBe(gaurav)
    expect(folderFromExplorerSnapshot({ title: "dist and 1 more tab - File Explorer", tabs })).toBe(dist)
    expect(folderFromExplorerSnapshot({ title: "Something else", tabs })).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("does not guess between tabs with the same visible name", () => {
  const root = mkdtempSync(join(tmpdir(), "pawwork-explorer-"))
  try {
    const first = join(root, "first", "Plans")
    const second = join(root, "second", "Plans")
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    expect(folderFromExplorerSnapshot({
      title: "Plans and 1 more tab - File Explorer",
      tabs: [{ name: "Plans", path: first }, { name: "Plans", path: second }],
    })).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
