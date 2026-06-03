import { test, expect } from "bun:test"
import {
  importedSessionConflictSet,
  localizeImportedSession,
  parseShareUrl,
  shouldAttachShareAuthHeaders,
  transformShareData,
  type ShareData,
} from "../../src/cli/cmd/import"
import { sameDirectory } from "../../src/session/execution-context"

// parseShareUrl tests
test("parses valid share URLs", () => {
  expect(parseShareUrl("https://opncd.ai/share/Jsj3hNIW")).toBe("Jsj3hNIW")
  expect(parseShareUrl("https://custom.example.com/share/abc123")).toBe("abc123")
  expect(parseShareUrl("http://localhost:3000/share/test_id-123")).toBe("test_id-123")
})

test("rejects invalid URLs", () => {
  expect(parseShareUrl("https://opncd.ai/s/Jsj3hNIW")).toBeNull() // legacy format
  expect(parseShareUrl("https://opncd.ai/share/")).toBeNull()
  expect(parseShareUrl("https://opncd.ai/share/id/extra")).toBeNull()
  expect(parseShareUrl("not-a-url")).toBeNull()
})

test("only attaches share auth headers for same-origin URLs", () => {
  expect(shouldAttachShareAuthHeaders("https://control.example.com/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("https://other.example.com/share/abc", "https://control.example.com")).toBe(false)
  expect(shouldAttachShareAuthHeaders("https://control.example.com:443/share/abc", "https://control.example.com")).toBe(
    true,
  )
  expect(shouldAttachShareAuthHeaders("not-a-url", "https://control.example.com")).toBe(false)
})

// transformShareData tests
test("transforms share data to storage format", () => {
  const data: ShareData[] = [
    { type: "session", data: { id: "sess-1", title: "Test" } as any },
    { type: "message", data: { id: "msg-1", sessionID: "sess-1" } as any },
    { type: "part", data: { id: "part-1", messageID: "msg-1" } as any },
    { type: "part", data: { id: "part-2", messageID: "msg-1" } as any },
  ]

  const result = transformShareData(data)!

  expect(result.info.id).toBe("sess-1")
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].parts).toHaveLength(2)
})

test("returns null for invalid share data", () => {
  expect(transformShareData([])).toBeNull()
  expect(transformShareData([{ type: "message", data: {} as any }])).toBeNull()
  expect(transformShareData([{ type: "session", data: { id: "s" } as any }])).toBeNull() // no messages
})

// localizeImportedSession tests
test("re-homes an imported session onto the local instance, dropping every foreign machine-local field", () => {
  const exported = {
    id: "sess-1",
    slug: "sess-1",
    projectID: "prj-exporter",
    directory: "/exporter/home/some-project/sub",
    workspaceID: "wsp-exporter",
    executionContext: {
      ownerDirectory: "/exporter/home/some-project",
      activeDirectory: "/exporter/home/some-project/sub",
      activeWorktree: { directory: "/exporter/home/.worktrees/x", name: "x", branch: "x", source: "existing" },
      lastChangedAt: 111,
    },
    title: "Imported",
    version: "1.0.0",
  } as any

  const localized = localizeImportedSession(exported, {
    projectID: "prj-local",
    directory: "/exporter-test/importer/local-project",
    ownerDirectory: "/exporter-test/importer/local-project",
  })

  // project + directory adopt the importing instance
  expect(localized.projectID).toBe("prj-local")
  expect(localized.directory).toBe("/exporter-test/importer/local-project")
  // foreign workspace binding is dropped (a foreign id would break workspace routing)
  expect(localized.workspaceID).toBeUndefined()
  // executionContext (the real shell/tool cwd source) is reseeded at the local owner;
  // the exporter's absolute paths and worktree are gone. rootContext canonicalizes the
  // owner dir (path.resolve + normalize), so assert directory identity, not a literal
  // string — a hardcoded POSIX path drive-prefixes to D:\... on Windows.
  expect(sameDirectory(localized.executionContext.ownerDirectory, "/exporter-test/importer/local-project")).toBe(true)
  expect(sameDirectory(localized.executionContext.activeDirectory, "/exporter-test/importer/local-project")).toBe(true)
  expect(sameDirectory(localized.executionContext.ownerDirectory, exported.executionContext.ownerDirectory)).toBe(false)
  expect(localized.executionContext.activeWorktree).toBeUndefined()
  // unrelated fields preserved; input not mutated
  expect(localized.id).toBe("sess-1")
  expect(localized.title).toBe("Imported")
  expect(exported.directory).toBe("/exporter/home/some-project/sub")
  expect(exported.workspaceID).toBe("wsp-exporter")
  expect(exported.executionContext.activeWorktree).toBeDefined()
})

test("re-import conflict set overwrites every re-homed column and clears a stale workspace to null", () => {
  const set = importedSessionConflictSet({
    project_id: "prj-local",
    directory: "/exporter-test/importer/local-project",
    workspace_id: undefined,
    execution_context: { ownerDirectory: "/exporter-test/importer/local-project", activeDirectory: "/exporter-test/importer/local-project", lastChangedAt: 1 },
  } as any)

  expect(set.project_id as string).toBe("prj-local")
  expect(set.directory).toBe("/exporter-test/importer/local-project")
  // undefined must become null (not be skipped) so re-import clears a stale foreign id
  expect(set.workspace_id).toBeNull()
  expect(set.execution_context).toEqual({
    ownerDirectory: "/exporter-test/importer/local-project",
    activeDirectory: "/exporter-test/importer/local-project",
    lastChangedAt: 1,
  })
})
