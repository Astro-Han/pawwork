import { describe, expect, test } from "bun:test"
import { LoopRenderer } from "../../src/session/loop-renderer"
import { SessionDiagnostics } from "../../src/session/diagnostics"

const makeState = (
  overrides: Partial<SessionDiagnostics.SignatureState> = {},
): SessionDiagnostics.SignatureState => ({
  kind: "input",
  completedFailures: 5,
  recoverEmitted: true,
  blockEmitted: true,
  ...overrides,
})

describe("LoopRenderer.render", () => {
  test("webfetch same_input shows the URL", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "input", lastInput: { url: "https://example.com/a" }, lastError: "boom" }),
    })
    expect(text).toContain("https://example.com/a")
    expect(text).toContain("5")
  })

  test("webfetch same_target shows URL and raw error", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "target", lastInput: { url: "https://example.com/a" }, lastError: "404 Not Found" }),
    })
    expect(text).toContain("https://example.com/a")
    expect(text).toContain("404 Not Found")
  })

  test("webfetch strips query string and fragment from rendered URL", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({
        kind: "target",
        lastInput: { url: "https://example.com/repo/file.md?token=secret-abc&q=visible#h1" },
        lastError: "404",
      }),
    })
    expect(text).toContain("https://example.com/repo/file.md")
    expect(text).not.toContain("token=")
    expect(text).not.toContain("secret-abc")
    expect(text).not.toContain("#h1")
  })

  test("missing lastInput uses degraded template (no <unknown> placeholder)", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "target", lastInput: undefined, lastError: "e" }),
    })
    expect(text).not.toContain("<unknown>")
    expect(text).toContain("5")
  })

  test("missing lastError omits error line in target template", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "target", lastInput: { url: "https://x.com/a" }, lastError: undefined }),
    })
    expect(text).toContain("https://x.com/a")
    expect(text).not.toContain("错误：")
  })

  test("non-webfetch same_target shows tool name and error but never raw input", () => {
    const text = LoopRenderer.render({
      tool: "bash",
      state: makeState({
        kind: "target",
        lastInput: { command: "curl -H 'Authorization: Bearer secret' https://internal/x" },
        lastError: "EACCES",
      }),
    })
    expect(text).toContain("bash")
    expect(text).toContain("EACCES")
    expect(text).not.toContain("curl")
    expect(text).not.toContain("Bearer")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("internal")
  })

  test("non-webfetch same_input shows tool name and error", () => {
    const text = LoopRenderer.render({
      tool: "grep",
      state: makeState({ kind: "input", lastInput: { pattern: "x" }, lastError: "permission denied" }),
    })
    expect(text).toContain("grep")
    expect(text).toContain("permission denied")
  })

  test("accepts a bare URL string as lastInput", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "target", lastInput: "https://x.com/a", lastError: "404" }),
    })
    expect(text).toContain("https://x.com/a")
  })

  test("scrubs Unix file paths in error text", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "/tmp/x" },
        lastError: "open /Users/alice/private.txt: permission denied",
      }),
    })
    expect(text).not.toContain("/Users/alice/private.txt")
    expect(text).toContain("permission denied")
  })

  test("scrubs Windows file paths in error text", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "C:/x" },
        lastError: "ENOENT C:\\Users\\bob\\secrets.json",
      }),
    })
    expect(text).not.toContain("C:\\Users\\bob\\secrets.json")
    expect(text).toContain("ENOENT")
  })

  test("scrubs relative paths (./foo, ../foo)", () => {
    const dot = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "./x" },
        lastError: "failed to open ./config/dev.json",
      }),
    })
    expect(dot).not.toContain("config/dev.json")
    expect(dot).toContain("failed to open")

    const dotdot = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "../x" },
        lastError: "ENOENT ../Secrets/token.txt",
      }),
    })
    expect(dotdot).not.toContain("Secrets")
    expect(dotdot).not.toContain("token.txt")
    expect(dotdot).toContain("ENOENT")
  })

  test("scrubs paths containing spaces (Unix)", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "/tmp/x" },
        lastError: "open /Users/alice/My Documents/secret.txt: permission denied",
      }),
    })
    expect(text).not.toContain("My Documents")
    expect(text).not.toContain("secret.txt")
    expect(text).toContain("permission denied")
  })

  test("scrubs paths containing spaces (Windows)", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "C:/x" },
        lastError: "ENOENT C:\\Users\\bob\\My Secrets\\token.txt",
      }),
    })
    expect(text).not.toContain("My Secrets")
    expect(text).not.toContain("token.txt")
    expect(text).toContain("ENOENT")
  })

  test("scrubs forward-slash Windows file paths (C:/...) in error text", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "C:/x" },
        lastError: "ENOENT C:/Users/bob/secrets.json: no such file",
      }),
    })
    expect(text).not.toContain("C:/Users/bob/secrets.json")
    expect(text).toContain("ENOENT")
  })

  test("scrubs quoted strings in error text", () => {
    const text = LoopRenderer.render({
      tool: "bash",
      state: makeState({
        kind: "target",
        lastInput: { command: "ls" },
        lastError: 'parsing failed: unexpected token "secret-payload" at position 12',
      }),
    })
    expect(text).not.toContain("secret-payload")
    expect(text).toContain("parsing failed")
  })

  test("scrubs Bearer/Basic auth headers and api key fragments in error text", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({
        kind: "target",
        lastInput: { url: "https://api.example.com/x" },
        lastError: "401 Unauthorized: Authorization: Bearer abc123-def456 invalid",
      }),
    })
    expect(text).not.toContain("abc123-def456")
    expect(text).toContain("401")
  })

  test("scrubs Unix paths even when preceded by punctuation, not just whitespace", () => {
    const text = LoopRenderer.render({
      tool: "read",
      state: makeState({
        kind: "input",
        lastInput: { filePath: "/tmp/x" },
        lastError: "Error:at /home/alice/secret.txt expected token",
      }),
    })
    expect(text).not.toContain("/home/alice/secret.txt")
    expect(text).toContain("Error")
  })

  test("scrubs URL even with uppercase scheme (HTTPS://)", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({
        kind: "target",
        lastInput: { url: "https://example.com/x" },
        lastError: "Got error from HTTPS://api.example.com/repo?token=secret-xyz",
      }),
    })
    expect(text).not.toContain("token=")
    expect(text).not.toContain("secret-xyz")
  })

  test("scrubs query/fragment from URLs embedded in error text", () => {
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({
        kind: "target",
        lastInput: { url: "https://example.com/x" },
        lastError: "Request to https://api.example.com/repo?token=secret-abc&q=visible#sect failed: 401",
      }),
    })
    expect(text).toContain("https://api.example.com/repo")
    expect(text).toContain("401")
    expect(text).not.toContain("token=")
    expect(text).not.toContain("secret-abc")
    expect(text).not.toContain("#sect")
  })

  test("truncates very long URLs", () => {
    const longURL = "https://x.com/" + "a".repeat(2000)
    const text = LoopRenderer.render({
      tool: "webfetch",
      state: makeState({ kind: "target", lastInput: { url: longURL }, lastError: "e" }),
    })
    expect(text.length).toBeLessThan(2200)
    expect(text).toContain("…")
  })
})
