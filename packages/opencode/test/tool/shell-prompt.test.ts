import { describe, expect, test } from "bun:test"
import { chainingFor, EXPECTED_OUTPUTS_DESCRIPTION, render } from "../../src/tool/shell/prompt"

const LIMITS = { maxLines: 2000, maxBytes: 50 * 1024 }
const DEFAULTS = {
  platform: "darwin" as NodeJS.Platform,
  directory: "/tmp/pawwork-test",
  tmp: "/tmp/global",
  limits: LIMITS,
  defaultTimeout: 120_000,
}

describe("bash prompt", () => {
  describe("chainingFor", () => {
    test("powershell rejects '&&' and recommends if ($?) conditional", () => {
      const text = chainingFor("powershell")
      expect(text).toContain("avoid '&&'")
      expect(text).toContain("Windows PowerShell 5.1")
      expect(text).toContain("cmd1; if ($?) { cmd2 }")
    })

    test("pwsh recommends '&&' with 5.1 fallback hint", () => {
      const text = chainingFor("pwsh")
      expect(text).toContain("'&&'")
      expect(text).toContain("PowerShell 7+")
      expect(text).toContain("cmd1; if ($?) { cmd2 }")
    })

    test("cmd recommends '&&' for cmd.exe", () => {
      const text = chainingFor("cmd")
      expect(text).toContain("'&&'")
      expect(text).toContain("cmd.exe")
      expect(text).not.toContain("PowerShell")
    })

    test("bash recommends '&&' single-call chaining", () => {
      const text = chainingFor("bash")
      expect(text).toContain("'&&'")
      expect(text).toContain("single Bash call")
      expect(text).not.toContain("PowerShell")
      expect(text).not.toContain("cmd.exe")
    })

    test("zsh and sh fall through to bash chaining", () => {
      expect(chainingFor("zsh")).toBe(chainingFor("bash"))
      expect(chainingFor("sh")).toBe(chainingFor("bash"))
    })
  })

  describe("render", () => {
    test("interpolates tmp, shell, os, maxLines, maxBytes", () => {
      const out = render({ ...DEFAULTS, name: "bash" })
      expect(out).toContain("/tmp/global")
      expect(out).toContain("Shell: bash")
      expect(out).toContain("OS: darwin")
      expect(out).toContain("2000 lines")
      expect(out).toContain("51200 bytes")
    })

    test("interpolates the configured default timeout, not the old hardcoded 120000ms / '2 minutes'", () => {
      // Regression for the shell.txt usage note that hardcoded "120000ms (2
      // minutes)" even though the default is configurable via
      // OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS (shell.ts:48). The rendered
      // prompt must reflect the real DEFAULT_TIMEOUT threaded in by the caller.
      // Adapted from upstream opencode #28998.
      const out = render({ ...DEFAULTS, name: "bash", defaultTimeout: 30_000 })
      expect(out).toContain("time out after 30000ms")
      expect(out).not.toContain("120000ms")
      expect(out).not.toContain("2 minutes")
    })

    test("no unreplaced template placeholders", () => {
      for (const name of ["bash", "pwsh", "powershell", "cmd"]) {
        const out = render({ ...DEFAULTS, name, platform: name === "bash" ? "darwin" : "win32" })
        expect(out).not.toMatch(/\$\{[a-zA-Z]+\}/)
      }
    })

    test("snapshot: powershell rendering carries the if ($?) hint", () => {
      const out = render({ ...DEFAULTS, name: "powershell", platform: "win32" })
      expect(out).toContain("cmd1; if ($?) { cmd2 }")
      expect(out).toContain("Shell: powershell")
      expect(out).toContain("OS: win32")
      expect(out).toContain("avoid '&&'")
    })

    test("snapshot: pwsh rendering keeps '&&' recommendation", () => {
      const out = render({ ...DEFAULTS, name: "pwsh", platform: "win32" })
      expect(out).toContain("PowerShell 7+")
      expect(out).toContain("Shell: pwsh")
      expect(out).not.toContain("avoid '&&'")
    })

    test("snapshot: cmd rendering points at cmd.exe", () => {
      const out = render({ ...DEFAULTS, name: "cmd", platform: "win32" })
      expect(out).toContain("cmd.exe")
      expect(out).toContain("Shell: cmd")
      expect(out).not.toContain("avoid '&&'")
    })

    test("snapshot: bash rendering has POSIX wording", () => {
      const out = render({ ...DEFAULTS, name: "bash" })
      expect(out).toContain("single Bash call")
      expect(out).toContain("Shell: bash")
      expect(out).not.toContain("avoid '&&'")
    })

    test("description corrects the one-shot wording (no persistent shell session claim)", () => {
      const out = render({ ...DEFAULTS, name: "bash" })
      expect(out).toContain("Each BashTool call runs in a fresh process")
      expect(out).not.toContain("persistent shell session")
    })

    test("expected_outputs description carries the strict ONLY/NEVER rule", () => {
      // Pinned at constant level so future edits cannot silently re-broaden
      // the rule without updating this test.
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("ONLY")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("deliverable artifact")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("DO NOT set it for")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("read-only inspection")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("officecli")
    })

    test("expected_outputs description: routine builds DO NOT set; named build deliverables DO", () => {
      // Routine compile/install loops must stay out of expected_outputs to
      // avoid noise, but a build that emits a specific named deliverable
      // (binary, report) MUST list that file or it slips past turn-change.
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("routine builds")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("named deliverable")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).toContain("list that file")
      expect(EXPECTED_OUTPUTS_DESCRIPTION).not.toMatch(/DO NOT set it for: tests, builds,/)
    })
  })
})
