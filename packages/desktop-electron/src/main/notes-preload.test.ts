import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vm from "node:vm"
import { expect, test, vi } from "vitest"

test("notes window exposes only its bounded notes and task actions", async () => {
  const invoke = vi.fn(async () => ({ path: "memory.md" }))
  let api: Record<string, (...args: unknown[]) => unknown> = {}
  vm.runInNewContext(readFileSync(resolve(import.meta.dirname, "../../resources/dsh/product/notes-preload.cjs"), "utf8"), {
    require: (name: string) => {
      if (name !== "electron") throw new Error(`unexpected dependency: ${name}`)
      return { contextBridge: { exposeInMainWorld: (_key: string, value: typeof api) => { api = value } }, ipcRenderer: { invoke, on: () => {}, removeListener: () => {} } }
    },
  })
  expect(Object.keys(api)).toEqual(["read", "chooseFile", "openFile", "save", "summarizePdf", "readPage", "savePage", "openPdf", "analyze", "listTasks", "saveTask", "changeTask", "onTasksChanged", "onTaskReminder", "onChanged", "onOpenFile"])
  await api.read()
  await api.save("file", "Important point")
  await api.summarizePdf()
  await api.listTasks()
  await api.changeTask("task-1", "complete")
  expect(invoke.mock.calls).toEqual([
    ["pawwork:notes:read"],
    ["pawwork:notes:save", "file", "Important point"],
    ["pawwork:notes:summarize-pdf"],
    ["pawwork:tasks:list"],
    ["pawwork:tasks:change", "task-1", "complete", undefined],
  ])
})
