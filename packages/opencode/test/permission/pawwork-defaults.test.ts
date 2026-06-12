import { afterEach, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

test("build agent uses PawWork permission defaults", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")

      expect(build).toBeDefined()
      expect(Permission.evaluate("read", "notes.txt", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "notes.txt", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", "/tmp/outside", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "ls -la", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "git status", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "chmod +x script.sh", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "kill 12345", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "dd if=/dev/zero of=disk.img", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "mkfs.ext4 /dev/sdb1", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rm file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rmdir folder", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "unlink file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "find . -delete", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "Remove-Item file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "del file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "erase file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rd folder", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "sudo rm -rf /", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("doom_loop", "*", build!.permission).action).toBe("ask")
      // Deliberate design ruling (browser design doc §9): every browser action
      // defaults to allow — the embedded browser is local and fully visible,
      // which is the safety net; permission.browser rules tighten per URL.
      expect(Permission.evaluate("browser", "https://example.com/page", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("opencli_read", "chatgpt-app/read", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("opencli_write", "spotify/play", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("question", "*", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("plan_enter", "*", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("plan_exit", "*", build!.permission).action).toBe("deny")
    },
  })
})

test("an origin-scoped browser 'always' grant never overrides another site's configured deny", async () => {
  // The other half of the §9 ruling: permission.browser rules tighten per URL,
  // and that tightening must survive an "always allow" click. Approvals are
  // evaluated after configured rules (last match wins), so the browser tools
  // scope the always grant to the asked site's origin — a global "*" grant
  // would silently void the user's own deny. SAME-origin denies (e.g.
  // /admin/* under an approved origin) are protected one level up: ask
  // short-circuits configured denies before approvals (see next.test.ts
  // "relaxes asks but never a configured deny").
  const configured = [
    { permission: "browser", pattern: "*", action: "ask" as const },
    { permission: "browser", pattern: "https://blocked.example/*", action: "deny" as const },
  ]
  const approved = [{ permission: "browser", pattern: "https://ok.example/*", action: "allow" as const }]
  expect(Permission.evaluate("browser", "https://ok.example/page", configured, approved).action).toBe("allow")
  expect(Permission.evaluate("browser", "https://blocked.example/page", configured, approved).action).toBe("deny")
  expect(Permission.evaluate("browser", "https://other.example/page", configured, approved).action).toBe("ask")
})
