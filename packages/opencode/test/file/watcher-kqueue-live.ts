import fs from "fs/promises"
import path from "path"
import { FileWatcher } from "../../src/file/watcher"

const workspace = process.argv[2]
if (!workspace) throw new Error("workspace argument is required")

const artifacts = [".worktrees", ".claude", ".claire", ".superpowers", "node_modules", ".turbo"]
const roots = artifacts.map((entry) => path.join(workspace, entry))
await Promise.all(roots.map((root) => fs.mkdir(root)))

const snapshotRoot = async () => {
  const snapshot = new Map<string, FileWatcher.RootEntryState>()
  for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
    const entryPath = path.join(workspace, entry.name)
    const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    const info = type === "file" ? await fs.stat(entryPath).catch(() => undefined) : undefined
    snapshot.set(entry.name, {
      name: entry.name,
      path: entryPath,
      type,
      size: info?.size ?? 0,
      mtimeMs: info?.mtimeMs ?? 0,
      ino: info?.ino ?? 0,
      ctimeMs: info?.ctimeMs ?? 0,
    })
  }
  return snapshot
}

const kqueueCount = () => {
  const result = Bun.spawnSync(["/usr/sbin/lsof", "-n", "-P", "-p", String(process.pid)])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => /\sKQUEUE\s/.test(line)).length
}

let callbacks = 0
let snapshots = 0
let fallbackTimers = 0
let callbackError: string | undefined
const discoveryErrors: string[] = []
const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
let expectedUpdate: { file: string; event: "add" | "change" | "unlink" } | undefined
let resolveUpdate = () => {}
const initialSnapshot = await snapshotRoot()
const before = kqueueCount()
const discovery = FileWatcher.createWorkspaceRootDiscovery({
  initialSnapshot,
  workspace,
  ignore: artifacts,
  subscribeSentinel: (snapshot, signal) =>
    FileWatcher.subscribeWorkspaceRootSentinel({
      workspace,
      snapshot,
      signal: (event) => {
        callbacks++
        if (event.error) callbackError = String(event.error)
        signal(event)
      },
    }),
  snapshotRoot: async () => {
    snapshots++
    return snapshotRoot()
  },
  applyPlan: async () => {},
  publishUpdate: (event) => {
    updates.push(event)
    if (expectedUpdate?.file === event.file && expectedUpdate.event === event.event) resolveUpdate()
  },
  publishRescan: async () => {},
  scheduleFallback: (callback, delayMs) => {
    fallbackTimers++
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
  onError: (error) => discoveryErrors.push(String(error)),
})
await discovery.start()
const after = kqueueCount()

for (const root of roots) {
  for (let index = 0; index < 167; index++) {
    await fs.writeFile(path.join(root, `churn-${index}.txt`), String(index))
  }
}
await Bun.sleep(300)
const ignoredCallbacks = callbacks
const idleSnapshots = snapshots

const rootFile = path.join(workspace, "root.txt")
const waitForUpdate = async (event: "add" | "change" | "unlink", trigger: () => Promise<void>) => {
  expectedUpdate = { file: rootFile, event }
  const update = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`root ${event} update timed out: ${JSON.stringify({ callbacks, snapshots, updates })}`)),
      5_000,
    )
    resolveUpdate = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  await trigger()
  await update
  expectedUpdate = undefined
}

await waitForUpdate("add", () => fs.writeFile(rootFile, "first"))
await waitForUpdate("change", () => fs.writeFile(rootFile, "other"))
await waitForUpdate("change", async () => {
  const replacement = path.join(roots[0]!, "replacement.txt")
  await fs.writeFile(replacement, "equal")
  await fs.rename(replacement, rootFile)
})
await waitForUpdate("unlink", () => fs.unlink(rootFile))

await discovery.dispose()
console.log(
  JSON.stringify({
    kqueueDescriptorDelta: after - before,
    ignoredCallbacks,
    idleSnapshots,
    rootCallbacks: callbacks - ignoredCallbacks,
    rootUpdates: updates.length,
    fallbackTimers,
    callbackError,
    discoveryErrors,
  }),
)
