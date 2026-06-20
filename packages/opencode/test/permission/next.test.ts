import { afterEach, test, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "os"
import path from "node:path"
import { Bus } from "../../src/bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Permission } from "../../src/permission"
import { fromDeniedRule, isPermanentDeleteRule, permanentDeleteSuggestions } from "../../src/permission/diagnostic"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { MessageID, SessionID } from "../../src/session/schema"
import { NotFoundError } from "../../src/storage/db"

afterEach(async () => {
  await Instance.disposeAll()
})

function askPermission(input: Permission.AskOptions, options?: Parameters<typeof AppRuntime.runPromise>[1]) {
  return AppRuntime.runPromise(Permission.Service.use((svc) => svc.ask(input)), options)
}

function replyPermission(input: Parameters<Permission.Interface["reply"]>[0]) {
  return AppRuntime.runPromise(Permission.Service.use((svc) => svc.reply(input)))
}

function listPermissions() {
  return AppRuntime.runPromise(Permission.Service.use((svc) => svc.list()))
}

async function rejectAll(message?: string) {
  for (const req of await listPermissions()) {
    await replyPermission({
      requestID: req.id,
      reply: "reject",
      message,
    })
  }
}

async function waitForPending(count: number) {
  for (let i = 0; i < 20; i++) {
    const list = await listPermissions()
    if (list.length === count) return list
    await Bun.sleep(0)
  }
  return listPermissions()
}

// fromConfig tests

test("fromConfig - string value becomes wildcard rule", () => {
  const result = Permission.fromConfig({ bash: "allow" })
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to rules array", () => {
  const result = Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - mixed string and object values", () => {
  const result = Permission.fromConfig({
    bash: { "*": "allow", rm: "deny" },
    edit: "allow",
    webfetch: "ask",
  })
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object", () => {
  const result = Permission.fromConfig({})
  expect(result).toEqual([])
})

test("fromConfig - expands tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "allow" }])
})

test("fromConfig - expands $HOME without trailing slash", () => {
  const result = Permission.fromConfig({ external_directory: { $HOME: "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("fromConfig - does not expand tilde in middle of path", () => {
  const result = Permission.fromConfig({ external_directory: { "/some/~/path": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: "/some/~/path", action: "allow" }])
})

// Top-level wildcard-vs-specific precedence semantics.
//
// fromConfig sorts top-level keys so wildcard permissions (containing "*")
// come before specific permissions. Combined with `findLast` in evaluate(),
// this gives the intuitive semantic "specific tool rules override the `*`
// fallback", regardless of the order the user wrote the keys in their JSON.
//
// Sub-pattern order inside a single permission key (e.g. `bash: { "*": "allow", "rm": "deny" }`)
// still depends on insertion order — only top-level keys are sorted.

test("fromConfig - specific key beats wildcard regardless of JSON key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  // Both orderings produce the same ruleset
  expect(wildcardFirst).toEqual(specificFirst)

  // And both evaluate bash → allow (bash rule wins over * fallback)
  expect(Permission.evaluate("bash", "ls", wildcardFirst).action).toBe("allow")
  expect(Permission.evaluate("bash", "ls", specificFirst).action).toBe("allow")
})

test("fromConfig - wildcard acts as fallback for permissions with no specific rule", () => {
  const ruleset = Permission.fromConfig({ bash: "allow", "*": "ask" })
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("ask")
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("fromConfig - top-level ordering: wildcards first, specifics after", () => {
  const ruleset = Permission.fromConfig({
    bash: "allow",
    "*": "ask",
    edit: "deny",
    "mcp_*": "allow",
  })
  // wildcards (* and mcp_*) come before specifics (bash, edit)
  const permissions = ruleset.map((r) => r.permission)
  expect(permissions.slice(0, 2).sort()).toEqual(["*", "mcp_*"])
  expect(permissions.slice(2)).toEqual(["bash", "edit"])
})

test("fromConfig - sub-pattern insertion order inside a tool key is preserved (only top-level sorts)", () => {
  // Sub-patterns within a single tool key use the documented "`*` first,
  // specific patterns after" convention (findLast picks specifics). The
  // top-level sort must not touch sub-pattern ordering.
  const ruleset = Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })
  expect(ruleset.map((r) => r.pattern)).toEqual(["*", "git *"])
  // * fallback for unknown commands
  expect(Permission.evaluate("bash", "rm foo", ruleset).action).toBe("deny")
  // specific pattern wins for git commands (it's last, findLast picks it)
  expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("allow")
})

test("fromConfig - canonical documented example unchanged", () => {
  // Regression guard for the example in docs/permissions.mdx
  const ruleset = Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })
  expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("allow")
  expect(Permission.evaluate("edit", "foo.ts", ruleset).action).toBe("deny")
  expect(Permission.evaluate("read", "foo.ts", ruleset).action).toBe("ask")
})

test("fromConfig - canonical agent overrides legacy task when both keys present", () => {
  // Mixed-key migration scenario: a config carrying both `agent` (canonical
  // post-#128 rename) and the legacy `task` alias. Without the legacy-skip
  // guard in fromConfig, `task -> agent` would land last under last-match-wins
  // and silently override the explicit canonical entry.
  const ruleset = Permission.fromConfig({ agent: "allow", task: "deny" })
  expect(Permission.evaluate("agent", "*", ruleset).action).toBe("allow")
  // Legacy-only configs still work — task maps to agent, agent gets the rule.
  const legacyOnly = Permission.fromConfig({ task: "deny" })
  expect(Permission.evaluate("agent", "*", legacyOnly).action).toBe("deny")
})

test("fromConfig - expands exact tilde to home directory", () => {
  const result = Permission.fromConfig({ external_directory: { "~": "allow" } })
  expect(result).toEqual([{ permission: "external_directory", pattern: os.homedir(), action: "allow" }])
})

test("evaluate - matches expanded tilde pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "~/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

test("evaluate - matches expanded $HOME pattern", () => {
  const ruleset = Permission.fromConfig({ external_directory: { "$HOME/projects/*": "allow" } })
  const result = Permission.evaluate("external_directory", `${os.homedir()}/projects/file.txt`, ruleset)
  expect(result.action).toBe("allow")
})

// merge tests

test("merge - simple concatenation", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - adds new permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "edit", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rules for same permission", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "foo", action: "ask" }],
    [{ permission: "bash", pattern: "*", action: "deny" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "foo", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - multiple rulesets", () => {
  const result = Permission.merge(
    [{ permission: "bash", pattern: "*", action: "allow" }],
    [{ permission: "bash", pattern: "rm", action: "ask" }],
    [{ permission: "edit", pattern: "*", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
  ])
})

test("merge - empty ruleset does nothing", () => {
  const result = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" }], [])
  expect(result).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("merge - preserves rule order", () => {
  const result = Permission.merge(
    [
      { permission: "edit", pattern: "src/*", action: "allow" },
      { permission: "edit", pattern: "src/secret/*", action: "deny" },
    ],
    [{ permission: "edit", pattern: "src/secret/ok.ts", action: "allow" }],
  )
  expect(result).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "allow" },
  ])
})

test("merge - config permission overrides default ask", () => {
  // Simulates: defaults have "*": "ask", config sets bash: "allow"
  const defaults: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "ask" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const merged = Permission.merge(defaults, config)

  // Config's bash allow should override default ask
  expect(Permission.evaluate("bash", "ls", merged).action).toBe("allow")
  // Other permissions should still be ask (from defaults)
  expect(Permission.evaluate("edit", "foo.ts", merged).action).toBe("ask")
})

test("merge - config ask overrides default allow", () => {
  // Simulates: defaults have bash: "allow", config sets bash: "ask"
  const defaults: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }]
  const merged = Permission.merge(defaults, config)

  // Config's ask should override default allow
  expect(Permission.evaluate("bash", "ls", merged).action).toBe("ask")
})

// evaluate tests

test("evaluate - exact pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard pattern match", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "bash", pattern: "*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching rule wins", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - last matching rule wins (wildcard after specific)", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - glob pattern match", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("allow")
})

test("evaluate - last matching glob wins", () => {
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/*", action: "deny" },
    { permission: "edit", pattern: "src/components/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - order matters for specificity", () => {
  // If more specific rule comes first, later wildcard overrides it
  const result = Permission.evaluate("edit", "src/components/Button.tsx", [
    { permission: "edit", pattern: "src/components/*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - unknown permission returns ask", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - empty ruleset returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - no matching pattern returns ask", () => {
  const result = Permission.evaluate("edit", "etc/passwd", [{ permission: "edit", pattern: "src/*", action: "allow" }])
  expect(result.action).toBe("ask")
})

test("evaluate - empty rules array returns ask", () => {
  const result = Permission.evaluate("bash", "rm", [])
  expect(result.action).toBe("ask")
})

test("evaluate - multiple matching patterns, last wins", () => {
  const result = Permission.evaluate("edit", "src/secret.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret.ts", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - non-matching patterns are skipped", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "edit", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "test/*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - exact match at end wins over earlier wildcard", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard at end overrides earlier exact match", () => {
  const result = Permission.evaluate("bash", "/bin/rm", [
    { permission: "bash", pattern: "/bin/rm", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

// wildcard permission tests

test("evaluate - wildcard permission matches any permission", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission with specific pattern", () => {
  const result = Permission.evaluate("bash", "rm", [{ permission: "*", pattern: "rm", action: "deny" }])
  expect(result.action).toBe("deny")
})

test("evaluate - glob permission pattern", () => {
  const result = Permission.evaluate("mcp_server_tool", "anything", [
    { permission: "mcp_*", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - specific permission and wildcard permission combined", () => {
  const result = Permission.evaluate("bash", "rm", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - wildcard permission does not match when specific exists", () => {
  const result = Permission.evaluate("edit", "src/foo.ts", [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "edit", pattern: "src/*", action: "allow" },
  ])
  expect(result.action).toBe("allow")
})

test("evaluate - multiple matching permission patterns combine rules", () => {
  const result = Permission.evaluate("mcp_dangerous", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "mcp_*", pattern: "*", action: "allow" },
    { permission: "mcp_dangerous", pattern: "*", action: "deny" },
  ])
  expect(result.action).toBe("deny")
})

test("evaluate - wildcard permission fallback for unknown tool", () => {
  const result = Permission.evaluate("unknown_tool", "anything", [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
  ])
  expect(result.action).toBe("ask")
})

test("evaluate - permission patterns sorted by length regardless of object order", () => {
  // specific permission listed before wildcard, but specific should still win
  const result = Permission.evaluate("bash", "rm", [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
  ])
  // With flat list, last matching rule wins - so "*" matches bash and wins
  expect(result.action).toBe("deny")
})

test("evaluate - merges multiple rulesets", () => {
  const config: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }]
  const approved: Permission.Ruleset = [{ permission: "bash", pattern: "rm", action: "deny" }]
  // approved comes after config, so rm should be denied
  const result = Permission.evaluate("bash", "rm", config, approved)
  expect(result.action).toBe("deny")
})

// disabled tests

test("disabled - returns empty set when all tools allowed", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "allow" }])
  expect(result.size).toBe(0)
})

test("disabled - disables tool when denied", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(false)
  expect(result.has("read")).toBe(false)
})

test("disabled - disables edit/write/apply_patch when edit denied", () => {
  const result = Permission.disabled(
    ["edit", "write", "apply_patch", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("edit")).toBe(true)
  expect(result.has("write")).toBe(true)
  expect(result.has("apply_patch")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when partially denied", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "rm *", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables every browser_* tool when the browser key is denied", () => {
  const result = Permission.disabled(
    ["browser_navigate", "browser_click", "browser_extract", "bash"],
    [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "browser", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("browser_navigate")).toBe(true)
  expect(result.has("browser_click")).toBe(true)
  expect(result.has("browser_extract")).toBe(true)
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when action is ask", () => {
  const result = Permission.disabled(["bash", "edit"], [{ permission: "*", pattern: "*", action: "ask" }])
  expect(result.size).toBe(0)
})

test("disabled - does not disable when specific allow after wildcard deny", () => {
  // Tool is NOT disabled because a specific allow after wildcard deny means
  // there's at least some usage allowed
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "echo *", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - does not disable when wildcard allow after deny", () => {
  const result = Permission.disabled(
    ["bash"],
    [
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
})

test("disabled - disables multiple tools", () => {
  const result = Permission.disabled(
    ["bash", "edit", "webfetch"],
    [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "webfetch", pattern: "*", action: "deny" },
    ],
  )
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("webfetch")).toBe(true)
})

test("disabled - wildcard permission denies all tools", () => {
  const result = Permission.disabled(["bash", "edit", "read"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("bash")).toBe(true)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - specific allow overrides wildcard deny", () => {
  const result = Permission.disabled(
    ["bash", "edit", "read"],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "allow" },
    ],
  )
  expect(result.has("bash")).toBe(false)
  expect(result.has("edit")).toBe(true)
  expect(result.has("read")).toBe(true)
})

test("disabled - the opencli group is hidden only when both opencli_read and opencli_write are denied", () => {
  const both = Permission.disabled(
    ["opencli_run", "opencli_search"],
    [
      { permission: "opencli_read", pattern: "*", action: "deny" },
      { permission: "opencli_write", pattern: "*", action: "deny" },
    ],
  )
  expect(both.has("opencli_run")).toBe(true)
  expect(both.has("opencli_search")).toBe(true)

  // Only the write half denied: read commands still run, so the group stays.
  const writeOnly = Permission.disabled(
    ["opencli_run", "opencli_search"],
    [{ permission: "opencli_write", pattern: "*", action: "deny" }],
  )
  expect(writeOnly.has("opencli_run")).toBe(false)
  expect(writeOnly.has("opencli_search")).toBe(false)
})

test("disabled - a browser deny no longer hides opencli tools", () => {
  const result = Permission.disabled(
    ["browser_navigate", "opencli_run", "opencli_search"],
    [{ permission: "browser", pattern: "*", action: "deny" }],
  )
  // browser deny still hides browser tools, but opencli is governed by its own keys.
  expect(result.has("browser_navigate")).toBe(true)
  expect(result.has("opencli_run")).toBe(false)
  expect(result.has("opencli_search")).toBe(false)
})

test("disabled - a global wildcard deny still hides opencli_run", () => {
  const result = Permission.disabled(["opencli_run"], [{ permission: "*", pattern: "*", action: "deny" }])
  expect(result.has("opencli_run")).toBe(true)
})

// ask tests

test("ask - resolves immediately when action is allow", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - throws RejectedError when action is deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        askPermission({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "deny" }],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("ask - an 'always' approval relaxes asks but never a configured deny", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // The browser tools' shape: a broad ask, a narrower deny the user wrote
      // down, and an origin-wide always grant. Approvals match after
      // configured rules, so without the deny short-circuit one click on the
      // harmless page would void the admin deny.
      const ruleset = [
        { permission: "browser", pattern: "*", action: "ask" as const },
        { permission: "browser", pattern: "https://example.com/admin/*", action: "deny" as const },
      ]
      const askPromise = askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "browser",
        patterns: ["https://example.com/home"],
        metadata: {},
        always: ["https://example.com/*"],
        ruleset,
      })
      const [pending] = await waitForPending(1)
      await replyPermission({ requestID: pending.id, reply: "always" })
      await askPromise

      // Same origin, denied path: the recorded approval matches the URL but
      // the configured deny stays the hard boundary.
      await expect(
        askPermission({
          sessionID: SessionID.make("session_test"),
          permission: "browser",
          patterns: ["https://example.com/admin/page"],
          metadata: {},
          always: ["https://example.com/*"],
          ruleset,
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)

      // Elsewhere on the site the approval does its job: no further ask.
      const ok = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "browser",
        patterns: ["https://example.com/other"],
        metadata: {},
        always: [],
        ruleset,
      })
      expect(ok).toBeUndefined()
    },
  })
})

test("reply - an 'always' grant survives an instance reload", async () => {
  await using tmp = await tmpdir({ git: true })
  const ruleset = [{ permission: "browser", pattern: "*", action: "ask" as const }]

  // First lifecycle: approve "always" for an origin.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = askPermission({
        sessionID: SessionID.make("session_persist"),
        permission: "browser",
        patterns: ["https://ok.example/home"],
        metadata: {},
        always: ["https://ok.example/*"],
        ruleset,
      })
      const [pending] = await waitForPending(1)
      await replyPermission({ requestID: pending.id, reply: "always" })
      await askPromise
    },
  })

  // Simulate an app restart: drop all in-memory instance state, then reload the
  // same project directory (its on-disk DB persists).
  await Instance.disposeAll()

  // Second lifecycle: the persisted grant auto-allows the same origin with no
  // further ask. Before the fix this re-asked, because the approval was only
  // ever held in memory and never written back to PermissionTable.
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await askPermission({
        sessionID: SessionID.make("session_persist_reload"),
        permission: "browser",
        patterns: ["https://ok.example/other"],
        metadata: {},
        always: ["https://ok.example/*"],
        ruleset,
      })
      expect(result).toBeUndefined()
      expect(await listPermissions()).toEqual([])
    },
  })
})

test("reply - sibling instances of one project merge their 'always' grants instead of clobbering", async () => {
  // Two directories under one git repo resolve to the SAME project id (project
  // id is the shared git-common-dir) but to DIFFERENT instances (instance state
  // is keyed by directory), so each holds its own in-memory `approved`. This is
  // the multi-worktree / multi-sandbox case where a whole-row write loses grants.
  await using repo = await tmpdir({ git: true })
  const dirA = path.join(repo.path, "a")
  const dirB = path.join(repo.path, "b")
  await fs.mkdir(dirA, { recursive: true })
  await fs.mkdir(dirB, { recursive: true })
  const ruleset = [{ permission: "bash", pattern: "*", action: "ask" as const }]

  // Load instance B's permission state while the project row is still empty, so
  // its in-memory `approved` is stale ([]) when it later writes. list() loads it.
  await Instance.provide({ directory: dirB, fn: () => listPermissions() })

  // Instance A grants "always" for `ls` and persists it to the shared row.
  await Instance.provide({
    directory: dirA,
    fn: async () => {
      const ask = askPermission({
        sessionID: SessionID.make("session_merge_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset,
      })
      const [pending] = await waitForPending(1)
      await replyPermission({ requestID: pending.id, reply: "always" })
      await ask
    },
  })

  // Instance B still holds the stale empty `approved`; it grants "always" for
  // `pwd`. A whole-row write would replace the row with only B's grant, dropping
  // A's `ls`. Merging the current row keeps both.
  await Instance.provide({
    directory: dirB,
    fn: async () => {
      const ask = askPermission({
        sessionID: SessionID.make("session_merge_b"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: ["pwd"],
        ruleset,
      })
      const [pending] = await waitForPending(1)
      await replyPermission({ requestID: pending.id, reply: "always" })
      await ask
    },
  })

  // Restart: drop in-memory state, reload the project, confirm BOTH grants
  // survived — a fresh instance auto-allows ls and pwd with no further ask.
  await Instance.disposeAll()
  await Instance.provide({
    directory: dirA,
    fn: async () => {
      const ls = await askPermission({
        sessionID: SessionID.make("session_merge_reload_ls"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset,
      })
      expect(ls).toBeUndefined()
      const pwd = await askPermission({
        sessionID: SessionID.make("session_merge_reload_pwd"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: ["pwd"],
        ruleset,
      })
      expect(pwd).toBeUndefined()
    },
  })
})

const bashDeleteCases = [
  { command: "rm file.txt", rule: "rm *" },
  { command: "rm -rf folder", rule: "rm -rf *" },
  { command: "rmdir folder", rule: "rmdir *" },
  { command: "unlink file.txt", rule: "unlink *" },
  { command: "find . -delete", rule: "find * -delete*" },
  { command: "Remove-Item file.txt", rule: "Remove-Item *" },
  { command: "Remove-Item -Recurse folder", rule: "Remove-Item -Recurse *" },
  { command: "del file.txt", rule: "del *" },
  { command: "erase file.txt", rule: "erase *" },
  { command: "rd folder", rule: "rd *" },
]

test.each(bashDeleteCases)(
  "ask - denied bash permanent delete includes structured diagnostic for $command",
  async ({ command, rule }) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const err = await askPermission({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: [command],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: rule, action: "deny" },
          ],
        }).then(
          () => undefined,
          (err) => err,
        )

        expect(err).toBeInstanceOf(Permission.DeniedError)
        if (!(err instanceof Permission.DeniedError)) return

        expect(err.ruleset).toEqual([
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: rule, action: "deny" },
        ])
        expect(err.diagnostic).toMatchObject({
          code: "permission.bash.permanent_delete_blocked",
          category: "permanent_delete",
          blockedCommand: command,
          matchedRule: { permission: "bash", pattern: rule, action: "deny" },
          reason: "This command permanently deletes files and is not reversible.",
        })
        expect(err.diagnostic?.suggestions.length).toBeGreaterThan(0)
        expect(err.message).toContain(`Command blocked: ${command}`)
        expect(err.message).toContain(`Matched rule: bash "${rule}" deny`)
        expect(err.message).toContain("Recommended next step:")
        expect(err.message).not.toContain("Here are some of the relevant rules")
      },
    })
  },
)

test("isPermanentDeleteRule - excludes allowed open-mode command families", () => {
  expect(isPermanentDeleteRule({ permission: "bash", pattern: "chmod *", action: "deny" })).toBe(false)
  expect(isPermanentDeleteRule({ permission: "bash", pattern: "kill *", action: "deny" })).toBe(false)
})

const bashGenericCases = [
  { command: "dd if=/dev/zero of=disk.img", rule: "dd *" },
  { command: "mkfs.ext4 /dev/sdb1", rule: "mkfs*" },
]

test.each(bashGenericCases)(
  "ask - denied non-delete bash command includes generic diagnostic for $command",
  async ({ command, rule }) => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const err = await askPermission({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: [command],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: rule, action: "deny" },
          ],
        }).then(
          () => undefined,
          (err) => err,
        )

        expect(err).toBeInstanceOf(Permission.DeniedError)
        if (!(err instanceof Permission.DeniedError)) return

        expect(err.diagnostic).toEqual({
          code: "permission.bash.denied",
          category: "generic",
          blockedCommand: command,
          matchedRule: { permission: "bash", pattern: rule, action: "deny" },
          reason: "This command is blocked by PawWork's safety policy.",
          suggestions: [
            {
              applicability: "ask_user",
              text: "Do not retry with another destructive command. Explain what you were trying to do and ask the user before proceeding.",
            },
          ],
        })
        expect(err.message).toContain(`Command blocked: ${command}`)
        expect(err.message).toContain(`Matched rule: bash "${rule}" deny`)
        expect(err.message).not.toContain("reversible trash command")
        expect(err.message).not.toContain("Here are some of the relevant rules")
      },
    })
  },
)

test("ask - non-bash denied permissions keep legacy message without bash diagnostic", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "edit",
        patterns: ["secret.txt"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "edit", pattern: "secret.txt", action: "deny" }],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      if (!(err instanceof Permission.DeniedError)) return

      expect(err.diagnostic).toBeUndefined()
      expect(err.message).toContain("Here are some of the relevant rules")
    },
  })
})

test("permission denial diagnostic suggestions are platform-specific", () => {
  expect(permanentDeleteSuggestions("darwin")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ applicability: "retryable", text: expect.stringContaining("command -v trash") }),
    ]),
  )
  expect(permanentDeleteSuggestions("linux")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ applicability: "retryable", text: expect.stringContaining("command -v gio") }),
      expect.objectContaining({ applicability: "retryable", text: expect.stringContaining("trash-put") }),
    ]),
  )

  const win32 = permanentDeleteSuggestions("win32")
  expect(win32).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        applicability: "ask_user",
        text: expect.stringContaining("PowerShell has no simple built-in recycle cmdlet"),
      }),
    ]),
  )
  expect(win32.map((item) => item.text).join("\n")).not.toContain("Use `Remove-Item`")

  expect(permanentDeleteSuggestions("freebsd")).toEqual([
    {
      applicability: "ask_user",
      text: "No reversible trash command is known for this platform. Ask the user before changing system state or deleting permanently.",
    },
  ])
})

test("fromDeniedRule accepts explicit platform for deterministic tests", () => {
  const diagnostic = fromDeniedRule({
    permission: "bash",
    blockedCommand: "rm file.txt",
    matchedRule: { permission: "bash", pattern: "rm *", action: "deny" },
    platform: "linux",
  })

  expect(diagnostic?.suggestions.map((item) => item.text).join("\n")).toContain("gio trash")
})

function expectPermanentDeleteNextStep(message: string) {
  if (os.platform() === "darwin" || os.platform() === "linux") {
    expect(message).toContain("trash <path>")
    return
  }
  expect(message).toContain("Recommended next step:")
}

test("ask - returns pending promise when action is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      // Promise should be pending, not resolved
      expect(promise).toBeInstanceOf(Promise)
      // Don't await - just verify it returns a promise
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - adds request to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      })

      const list = await listPermissions()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
      })

      await rejectAll()
      await ask.catch(() => {})
    },
  })
})

test("ask - publishes asked event", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      let seen: Permission.Request | undefined
      const unsub = Bus.subscribe(Permission.Event.Asked, (event) => {
        seen = event.properties
      })

      const ask = askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: { cmd: "ls" },
        always: ["ls"],
        tool: {
          messageID: MessageID.make("msg_test"),
          callID: "call_test",
        },
        ruleset: [],
      })

      expect(await listPermissions()).toHaveLength(1)
      expect(seen).toBeDefined()
      expect(seen).toMatchObject({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
      })

      unsub()
      await rejectAll()
      await ask.catch(() => {})
    },
  })
})

// reply tests

test("reply - once resolves the pending ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = askPermission({
        id: PermissionID.make("per_test1"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await replyPermission({
        requestID: PermissionID.make("per_test1"),
        reply: "once",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
})

test("reply - reject throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = askPermission({
        id: PermissionID.make("per_test2"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await replyPermission({
        requestID: PermissionID.make("per_test2"),
        reply: "reject",
      })

      await expect(askPromise).rejects.toBeInstanceOf(Permission.RejectedError)
    },
  })
})

test("reply - reject with message throws CorrectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = askPermission({
        id: PermissionID.make("per_test2b"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      await replyPermission({
        requestID: PermissionID.make("per_test2b"),
        reply: "reject",
        message: "Use a safer command",
      })

      const err = await ask.catch((err) => err)
      expect(err).toBeInstanceOf(Permission.CorrectedError)
      expect(err.message).toContain("Use a safer command")
    },
  })
})

test("reply - always persists approval and resolves", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise = askPermission({
        id: PermissionID.make("per_test3"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      await waitForPending(1)

      await replyPermission({
        requestID: PermissionID.make("per_test3"),
        reply: "always",
      })

      await expect(askPromise).resolves.toBeUndefined()
    },
  })
  // Re-provide to reload state with stored permissions
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // Stored approval should allow without asking
      const result = await askPermission({
        sessionID: SessionID.make("session_test2"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("reply - reject cancels all pending for same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const askPromise1 = askPermission({
        id: PermissionID.make("per_test4a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      const askPromise2 = askPermission({
        id: PermissionID.make("per_test4b"),
        sessionID: SessionID.make("session_same"),
        permission: "edit",
        patterns: ["foo.ts"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      // Catch rejections before they become unhandled
      const result1 = askPromise1.catch((e) => e)
      const result2 = askPromise2.catch((e) => e)

      // Reject the first one
      await replyPermission({
        requestID: PermissionID.make("per_test4a"),
        reply: "reject",
      })

      // Both should be rejected
      expect(await result1).toBeInstanceOf(Permission.RejectedError)
      expect(await result2).toBeInstanceOf(Permission.RejectedError)
    },
  })
})

test("reply - always resolves matching pending requests in same session", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = askPermission({
        id: PermissionID.make("per_test5a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      const b = askPermission({
        id: PermissionID.make("per_test5b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      await replyPermission({
        requestID: PermissionID.make("per_test5a"),
        reply: "always",
      })

      await expect(a).resolves.toBeUndefined()
      await expect(b).resolves.toBeUndefined()
      expect(await listPermissions()).toHaveLength(0)
    },
  })
})

test("reply - always keeps other session pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = askPermission({
        id: PermissionID.make("per_test6a"),
        sessionID: SessionID.make("session_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      const b = askPermission({
        id: PermissionID.make("per_test6b"),
        sessionID: SessionID.make("session_b"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      await replyPermission({
        requestID: PermissionID.make("per_test6a"),
        reply: "always",
      })

      await expect(a).resolves.toBeUndefined()
      expect((await listPermissions()).map((x) => x.id)).toEqual([PermissionID.make("per_test6b")])

      await rejectAll()
      await b.catch(() => {})
    },
  })
})

test("reply - publishes replied event", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ask = askPermission({
        id: PermissionID.make("per_test7"),
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(1)

      let seen:
        | {
            sessionID: SessionID
            requestID: PermissionID
            reply: Permission.Reply
          }
        | undefined
      const unsub = Bus.subscribe(Permission.Event.Replied, (event) => {
        seen = event.properties
      })

      await replyPermission({
        requestID: PermissionID.make("per_test7"),
        reply: "once",
      })

      await expect(ask).resolves.toBeUndefined()
      expect(seen).toEqual({
        sessionID: SessionID.make("session_test"),
        requestID: PermissionID.make("per_test7"),
        reply: "once",
      })
      unsub()
    },
  })
})

test("permission requests stay isolated by directory", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })

  const a = Instance.provide({
    directory: one.path,
    fn: () =>
      askPermission({
        id: PermissionID.make("per_dir_a"),
        sessionID: SessionID.make("session_dir_a"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })

  const b = Instance.provide({
    directory: two.path,
    fn: () =>
      askPermission({
        id: PermissionID.make("per_dir_b"),
        sessionID: SessionID.make("session_dir_b"),
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })

  const onePending = await Instance.provide({
    directory: one.path,
    fn: () => waitForPending(1),
  })
  const twoPending = await Instance.provide({
    directory: two.path,
    fn: () => waitForPending(1),
  })

  expect(onePending).toHaveLength(1)
  expect(twoPending).toHaveLength(1)
  expect(onePending[0].id).toBe(PermissionID.make("per_dir_a"))
  expect(twoPending[0].id).toBe(PermissionID.make("per_dir_b"))

  await Instance.provide({
    directory: one.path,
    fn: () => replyPermission({ requestID: onePending[0].id, reply: "reject" }),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => replyPermission({ requestID: twoPending[0].id, reply: "reject" }),
  })

  await a.catch(() => {})
  await b.catch(() => {})
})

test("pending permission rejects on instance dispose", async () => {
  await using tmp = await tmpdir({ git: true })

  const ask = Instance.provide({
    directory: tmp.path,
    fn: () =>
      askPermission({
        id: PermissionID.make("per_dispose"),
        sessionID: SessionID.make("session_dispose"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })
  const result = ask.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await waitForPending(1)
      expect(pending).toHaveLength(1)
      await Instance.dispose()
    },
  })

  expect(await result).toBeInstanceOf(Permission.RejectedError)
})

test("pending permission rejects on instance reload", async () => {
  await using tmp = await tmpdir({ git: true })

  const ask = Instance.provide({
    directory: tmp.path,
    fn: () =>
      askPermission({
        id: PermissionID.make("per_reload"),
        sessionID: SessionID.make("session_reload"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      }),
  })
  const result = ask.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await waitForPending(1)
      expect(pending).toHaveLength(1)
      await Instance.reload({ directory: tmp.path })
    },
  })

  expect(await result).toBeInstanceOf(Permission.RejectedError)
})

test("reply - throws NotFoundError for an unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        replyPermission({
          requestID: PermissionID.make("per_unknown"),
          reply: "once",
        }),
      ).rejects.toBeInstanceOf(NotFoundError)
      expect(await listPermissions()).toHaveLength(0)
    },
  })
})

test("reply - is idempotent for a cascade-resolved sibling", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const a = askPermission({
        id: PermissionID.make("per_idem_a"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: ["ls"],
        ruleset: [],
      })

      const b = askPermission({
        id: PermissionID.make("per_idem_b"),
        sessionID: SessionID.make("session_same"),
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
        ruleset: [],
      })

      await waitForPending(2)

      // Replying "always" to a cascade-resolves the matching sibling b.
      await replyPermission({ requestID: PermissionID.make("per_idem_a"), reply: "always" })
      await expect(a).resolves.toBeUndefined()
      await expect(b).resolves.toBeUndefined()

      // The client legitimately saw b and replies to it; that repeat reply must
      // be an idempotent success, not a NotFoundError.
      await expect(
        replyPermission({ requestID: PermissionID.make("per_idem_b"), reply: "once" }),
      ).resolves.toBeUndefined()
    },
  })
})

test("ask - denies when any pattern matches a deny rule", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(
        askPermission({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["echo hello", "rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [
            { permission: "bash", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        }),
      ).rejects.toBeInstanceOf(Permission.DeniedError)
    },
  })
})

test("ask - denial diagnostic uses the actual denied pattern in compound commands", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo ok", "rm file.txt"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      if (!(err instanceof Permission.DeniedError)) return

      expect(err.diagnostic?.blockedCommand).toBe("rm file.txt")
      expect(err.message).toContain("Command blocked: rm file.txt")
      expect(err.message).not.toContain("Command blocked: echo ok")
    },
  })
})

test("ask - denial diagnostic keeps flags and multiple operands without rewriting command", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["rm -rf dir other"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      if (!(err instanceof Permission.DeniedError)) return

      expect(err.diagnostic?.blockedCommand).toBe("rm -rf dir other")
      expect(err.message).toContain("Command blocked: rm -rf dir other")
      expectPermanentDeleteNextStep(err.message)
      expect(err.message).not.toContain("trash dir other")
    },
  })
})

test("ask - denial diagnostic summarizes additional blocked commands", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["rm a", "rmdir b"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "rm *", action: "deny" },
          { permission: "bash", pattern: "rmdir *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      if (!(err instanceof Permission.DeniedError)) return

      expect(err.diagnostic?.blockedCommand).toBe("rm a")
      expect(err.diagnostic?.additionalBlockedCommands).toEqual([
        { blockedCommand: "rmdir b", matchedRule: { permission: "bash", pattern: "rmdir *", action: "deny" } },
      ])
      expect(err.message).toContain("Command blocked: rm a")
      expect(err.message).toContain("Additional blocked commands (1): rmdir b")
    },
  })
})

test("ask - permanent delete denial is primary when a generic denial comes first", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["dd if=/dev/zero of=disk.img", "rm file.txt"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "dd *", action: "deny" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      if (!(err instanceof Permission.DeniedError)) return

      expect(err.diagnostic?.category).toBe("permanent_delete")
      expect(err.diagnostic?.blockedCommand).toBe("rm file.txt")
      expect(err.diagnostic?.additionalBlockedCommands).toEqual([
        {
          blockedCommand: "dd if=/dev/zero of=disk.img",
          matchedRule: { permission: "bash", pattern: "dd *", action: "deny" },
        },
      ])
      expect(err.message).toContain("Command blocked: rm file.txt")
      expectPermanentDeleteNextStep(err.message)
      expect(err.message).toContain("Additional blocked commands (1): dd if=/dev/zero of=disk.img")
    },
  })
})

test("ask - denied error remains compatible without diagnostic", () => {
  const err = new Permission.DeniedError({
    ruleset: [{ permission: "bash", pattern: "rm *", action: "deny" }],
  })

  expect(err.ruleset).toEqual([{ permission: "bash", pattern: "rm *", action: "deny" }])
  expect(err.diagnostic).toBeUndefined()
  expect(err.message).toContain("Here are some of the relevant rules")
})

test("ask - allows all patterns when all match allow rules", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "ls -la", "pwd"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      expect(result).toBeUndefined()
    },
  })
})

test("ask - should deny even when an earlier pattern is ask", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const err = await askPermission({
        sessionID: SessionID.make("session_test"),
        permission: "bash",
        patterns: ["echo hello", "rm -rf /"],
        metadata: {},
        always: [],
        ruleset: [
          { permission: "bash", pattern: "echo *", action: "ask" },
          { permission: "bash", pattern: "rm *", action: "deny" },
        ],
      }).then(
        () => undefined,
        (err) => err,
      )

      expect(err).toBeInstanceOf(Permission.DeniedError)
      expect(await listPermissions()).toHaveLength(0)
    },
  })
})

test("ask - abort should clear pending request", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const ctl = new AbortController()
      const ask = askPermission(
        {
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["ls"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
        },
        { signal: ctl.signal },
      )

      await waitForPending(1)
      ctl.abort()
      await ask.catch(() => {})

      try {
        expect(await listPermissions()).toHaveLength(0)
      } finally {
        await rejectAll()
      }
    },
  })
})
