import { expect, test } from "bun:test"
import { readdir, readFile } from "fs/promises"
import path from "path"

const srcRoot = path.resolve(import.meta.dir, "../../src")
const testRoot = path.resolve(import.meta.dir, "..")

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filepath = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(filepath)
      if (!entry.isFile()) return []
      if (!/\.[cm]?tsx?$/.test(entry.name)) return []
      return [filepath]
    }),
  )
  return files.flat()
}

function relativeSource(file: string) {
  return path.relative(srcRoot, file).split(path.sep).join("/")
}

test("legacy Flock imports stay in explicit Promise lease boundaries", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (/\bfrom\s+["'](?:@\/util\/flock|@opencode-ai\/core\/util\/flock|(?:\.\.\/)+util\/flock)["']/.test(text)) {
      hits.push(relativeSource(file))
    }
  }

  expect(hits.sort()).toEqual(["automation/index.ts", "automation/scheduler.ts"])
})

test("async lazy stays in explicit compatibility boundaries", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (/\blazy\s*\(\s*async\b/.test(text)) hits.push(relativeSource(file))
  }

  expect(hits.sort()).toEqual([])
})

test("production source does not use Promise flock compatibility", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (text.includes("EffectFlock.withLockPromise")) hits.push(relativeSource(file))
  }

  expect(hits.sort()).toEqual([])
})

test("worktree adaptor does not call Worktree Promise facades", async () => {
  const text = await readFile(path.join(srcRoot, "control-plane/adaptors/worktree.ts"), "utf8")

  expect(text).not.toContain("Worktree.makeWorktreeInfo")
  expect(text).not.toContain("Worktree.createFromInfo")
  expect(text).not.toContain("Worktree.remove")
})

test("Worktree service uses the Effect-native gitignore guard boundary", async () => {
  const text = await readFile(path.join(srcRoot, "worktree/index.ts"), "utf8")

  expect(text).not.toContain("Effect.promise(() => ensureWorktreesIgnored")
  expect(text).not.toContain("Effect.promise(() => restoreWorktreesIgnored")
})

test("Worktree service uses the Effect-native session active binding boundary", async () => {
  const text = await readFile(path.join(srcRoot, "worktree/index.ts"), "utf8")

  expect(text).not.toContain("Session.findActiveWorktreeBinding(")
})

test("provider list route uses the ModelsDev service instead of the Promise facade", async () => {
  const text = await readFile(path.join(srcRoot, "server/instance/provider-actions.ts"), "utf8")

  expect(text).not.toContain("Effect.promise(() => ModelsDev.get())")
  expect(text).not.toContain("ModelsDev.get()")
})

test("ModelState recent writes stay on the Effect service boundary", async () => {
  const service = await readFile(path.join(srcRoot, "provider/model-state.ts"), "utf8")
  const providerTest = await readFile(path.join(testRoot, "provider/provider.test.ts"), "utf8")

  expect(service).not.toContain("makeRuntime(Service, defaultLayer)")
  expect(service).not.toContain("export async function recordRecent")
  expect(providerTest).not.toContain("ModelState.recordRecent(")
})

test("Snapshot service does not expose Promise facades", async () => {
  const service = await readFile(path.join(srcRoot, "snapshot/index.ts"), "utf8")
  const snapshotTest = await readFile(path.join(testRoot, "snapshot/snapshot.test.ts"), "utf8")
  const facades = [
    "export async function init",
    "export async function track",
    "export async function patch",
    "export async function restore",
    "export async function revert",
    "export async function diff",
    "export async function diffFull",
  ]

  expect(service).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
  expect(service).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
  for (const facade of facades) expect(service).not.toContain(facade)
  expect(snapshotTest).not.toMatch(/\bSnapshot\.(init|track|patch|restore|revert|diff|diffFull)\s*\(/)
})

test("session summary/revert/compaction services do not expose Promise facades", async () => {
  const files = {
    "session/summary.ts": ["export async function diff", "export async function artifacts"],
    "session/revert.ts": ["export const revert =", "export const unrevert =", "export const cleanup ="],
    "session/compaction.ts": ["export async function isOverflow", "export async function prune", "export const create ="],
  }

  for (const [file, facades] of Object.entries(files)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("Session service does not expose Promise facades", async () => {
  const text = await readFile(path.join(srcRoot, "session/session.ts"), "utf8")
  const facades = [
    "export const create =",
    "export const get =",
    "export const children =",
    "export const fork =",
    "export const remove =",
    "export const setTitle =",
    "export const setArchived =",
    "export const setPermission =",
    "export const messages =",
    "export const messagesPage =",
    "export const removePart =",
    "export const updateMessage =",
    "export const updatePart =",
    "export const updateExecutionContext =",
    "export const findActiveWorktreeBinding =",
  ]

  expect(text).not.toMatch(/\bfrom\s+["']\.\.\/effect\/run-service["']/)
  expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
  for (const facade of facades) expect(text).not.toContain(facade)
})

test("TurnChange service does not expose sync or Promise facades", async () => {
  const text = await readFile(path.join(srcRoot, "session/turn-change.ts"), "utf8")
  const facades = [
    "export function recordWrite",
    "export function recordUncaptured",
    "export function finalize",
    "export function get",
    "export function aggregateTurn",
    "export function aggregateTurnUnion",
    "export function aggregateSessionFromTurns",
    "export function undo",
    "export function redo",
    "export function aggregateTurnUndo",
    "export function aggregateTurnRedo",
  ]

  expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
  expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
  for (const facade of facades) expect(text).not.toContain(facade)
})

test("Agent and Settings services do not expose Promise facades", async () => {
  const services = {
    "agent/agent.ts": [
      "export async function get",
      "export async function list",
      "export async function defaultAgent",
      "export async function generate",
    ],
    "settings/index.ts": [
      "export const lspEnabled = async",
      "export const setLspEnabled = async",
      "export const webSearchEnabled = async",
      "export const setWebSearchEnabled = async",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("LSP and Pty services do not expose Promise facades", async () => {
  const services = {
    "lsp/index.ts": [
      "export const init = async",
      "export const status = async",
      "export const hasClients = async",
      "export const touchFile = async",
      "export const diagnostics = async",
      "export const hover = async",
      "export const definition = async",
      "export const references = async",
      "export const implementation = async",
      "export const documentSymbol = async",
      "export const workspaceSymbol = async",
      "export const prepareCallHierarchy = async",
      "export const incomingCalls = async",
      "export const outgoingCalls = async",
      "export const shutdownAll = async",
      "export const invalidate = async",
    ],
    "pty/index.ts": [
      "export async function list",
      "export async function get",
      "export async function write",
      "export async function connect",
      "export async function create",
      "export async function update",
      "export async function remove",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("Auth and WebSearchAuth services do not expose Promise facades", async () => {
  const services = {
    "auth/index.ts": [
      "export async function get",
      "export async function all",
      "export async function set",
      "export async function remove",
    ],
    "tool/websearch-auth.ts": [
      "export async function status",
      "export async function saveKey",
      "export async function removeKey",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bfrom\s+["']\.\.\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("Config service does not expose Promise facades", async () => {
  const text = await readFile(path.join(srcRoot, "config/config.ts"), "utf8")
  const facades = [
    "export async function get",
    "export async function getGlobal",
    "export async function getConsoleState",
    "export async function update",
    "export async function updateGlobal",
    "export async function seedGlobalConfig",
    "export async function invalidate",
    "export async function directories",
    "export async function waitForDependencies",
    "export async function installDependencies",
  ]

  expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
  for (const facade of facades) expect(text).not.toContain(facade)
})

test("Plugin and Skill services do not expose Promise facades", async () => {
  const services = {
    "plugin/index.ts": ["export async function trigger", "export async function list", "export async function init"],
    "skill/index.ts": [
      "export async function get",
      "export async function all",
      "export async function dirs",
      "export async function available",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("File and SessionShare services do not expose Promise facades", async () => {
  const services = {
    "file/index.ts": [
      "export function init",
      "export async function status",
      "export async function read",
      "export async function list",
      "export async function search",
    ],
    "share/session.ts": ["export const create =", "export const share =", "export const unshare ="],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})

test("MCP services do not expose Promise facades", async () => {
  const services = {
    "mcp/index.ts": [
      "status",
      "tools",
      "prompts",
      "resources",
      "add",
      "connect",
      "disconnect",
      "startAuth",
      "authenticate",
      "finishAuth",
      "removeAuth",
      "supportsOAuth",
      "hasStoredTokens",
      "getAuthStatus",
    ],
    "mcp/auth.ts": [
      "get",
      "getForUrl",
      "all",
      "set",
      "remove",
      "updateTokens",
      "updateClientInfo",
      "updateCodeVerifier",
      "updateOAuthState",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) {
      expect(text).not.toMatch(new RegExp(`\\bexport\\s+const\\s+${facade}\\b`))
    }
  }
})

test("Project, Vcs, and Worktree services do not expose Promise facades", async () => {
  const services = {
    "project/project.ts": [
      "export function fromDirectory",
      "export function discover",
      "export function list",
      "export function get",
      "export function setInitialized",
      "export function initGit",
      "export function update",
      "export function sandboxes",
      "export function addSandbox",
      "export function removeSandbox",
    ],
    "project/vcs.ts": [
      "export async function init",
      "export async function branch",
      "export async function defaultBranch",
      "export async function status",
      "export async function diff",
      "export async function diffRaw",
      "export async function apply",
    ],
    "worktree/index.ts": [
      "export async function makeWorktreeInfo",
      "export async function createFromInfo",
      "export async function create",
      "export async function createReady",
      "export async function list",
      "export async function lookupByDirectory",
      "export async function lookupBySlug",
      "export async function registerExistingByPath",
      "export async function remove",
      "export async function reset",
    ],
  }

  for (const [file, facades] of Object.entries(services)) {
    const text = await readFile(path.join(srcRoot, file), "utf8")
    expect(text).not.toMatch(/\bfrom\s+["']@\/effect\/run-service["']/)
    expect(text).not.toMatch(/\bmakeRuntime\s*\(\s*Service\s*,\s*defaultLayer\s*\)/)
    for (const facade of facades) expect(text).not.toContain(facade)
  }
})
