import { describe, expect, test } from "bun:test"
import { buildProblemReport, type ProblemReportDiagnostics, parseProblemReportPayload } from "./problem-report"
import {
  makeRedactor,
  sanitizeSessionInfo,
  sanitizeSessionMessages,
  SESSION_PART_TEXT_MAX_CHARS,
} from "./problem-report-redact"

// Bare secret values (no quotes), so the assertions test the secret itself, not JSON escaping.
// The provider prefixes are split with `+` so these dummy fixtures do not trip GitHub push
// protection's secret scanner — the concatenated runtime value still matches the redaction rules.
const TOKENS = {
  anthropic: "sk-ant-" + "api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG",
  openaiProject: "sk-proj-" + "abcdefGHIJKL1234567890mnopqrst",
  openrouter: "sk-or-v1-" + "abcdef0123456789abcdef0123456789",
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  google: "AIza" + "SyA1234567890abcdefghijklmnopqrstuv",
  gitlab: "glpat-" + "abcdefGHIJKL1234567890",
  github: "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  huggingface: "hf_" + "abcdefghijklmnopqrstuvwx",
  npm: "npm_" + "abcdefghijklmnopqrstuvwxyz0123456789",
  slack: "xoxb-" + "1234567890-abcdefghijkl",
  stripe: "sk_live_" + "abcdefghijklmnopqrstuvwx",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk",
  password: "hunter2-secret-pw",
  bearer: "abcdef0123456789ABCDEFtokenvalue",
  basicPass: "p4ssw0rd",
}
const PATHS = {
  win: "C:\\Users\\alice\\secret\\app.log",
  posix: "/Users/alice/workspace/project/index.ts",
  home: "/home/alice/.config/PawWork/key.dat",
  unc: "\\\\server\\share\\alice\\secret.log",
  file: "file:///Users/alice/notes.md",
  tilde: "~/secrets/config.json",
  tildeUser: "~bob/private/notes.txt",
  root: "/root/.ssh/id_rsa",
  etc: "/etc/shadow.bak",
  usrLocal: "/usr/local/secret/keys.txt",
  library: "/Library/Application/PawWork/state.json",
  workspace: "/workspace/private/repo/.env",
  nix: "/nix/store/abcd-secret-pkg/bin",
  system: "/System/Library/Caches/com.app/secret.db",
}
const USERNAME = "alice"
const EMAIL = "alice@corp.example.com"

function validDiagnostics(overrides: Partial<ProblemReportDiagnostics> = {}): ProblemReportDiagnostics {
  return {
    appVersion: "2026.6.11",
    channel: "stable",
    packaged: true,
    updaterEnabled: true,
    platform: "win32",
    osVersion: "Windows 10",
    arch: "x64",
    electronVersion: "40.0.0",
    locale: "en",
    route: "/session/ses_1",
    directory: PATHS.win,
    sessionID: "ses_1",
    logPath: PATHS.posix,
    ...overrides,
  }
}

describe("makeRedactor", () => {
  const redact = makeRedactor([USERNAME, "/home/alice"])

  // Self-identifying tokens carry their own prefix, so they redact even as bare values.
  const selfIdentifying = [
    "anthropic",
    "openaiProject",
    "openrouter",
    "aws",
    "google",
    "gitlab",
    "github",
    "huggingface",
    "npm",
    "slack",
    "stripe",
    "jwt",
  ] as const

  test("redacts self-identifying tokens even as bare values", () => {
    for (const name of selfIdentifying) {
      const token = TOKENS[name]
      expect(redact(`prefix ${token} suffix`), name).not.toContain(token)
    }
  })

  test("redacts context-bearing credentials in their assignment/auth forms", () => {
    expect(redact(`password="${TOKENS.password}"`)).not.toContain(TOKENS.password)
    expect(redact(`Authorization: Bearer ${TOKENS.bearer}`)).not.toContain(TOKENS.bearer)
    expect(redact(`url https://${USERNAME}:${TOKENS.basicPass}@host/api`)).not.toContain(TOKENS.basicPass)
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----")).toBe("[redacted-key]")
  })

  test("redacts HTTP Basic auth credentials, not just the scheme word", () => {
    // The base64 must not survive past the scheme; the generic key=value rule alone would stop at "Basic".
    expect(redact("Authorization: Basic dXNlcjpwYXNzd29yZA==")).not.toContain("dXNlcjpwYXNzd29yZA")
    expect(redact("Proxy-Authorization: Basic Zm9vOmJhcg==")).not.toContain("Zm9vOmJhcg")
    // Prose that merely mentions the scheme is left alone.
    expect(redact("server supports Basic Authentication")).toContain("Basic Authentication")
  })

  test("redacts vendor-prefixed and camelCase credential field names", () => {
    expect(redact("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY")).not.toContain("wJalrXUtnFEMIK")
    expect(redact('clientSecret: "abcd1234efgh5678"')).not.toContain("abcd1234efgh5678")
    expect(redact('"accessToken":"tok_abcdefghijklmnop"')).not.toContain("tok_abcdefghijklmnop")
  })

  test("redacts a multi-word quoted secret without leaking its tail", () => {
    // The value matcher consumes the whole quoted string, not just the first word.
    expect(redact('password="correct horse battery staple"')).not.toContain("horse battery staple")
  })

  test("does not over-redact 'tokens'/'tokenizer' assignments (diagnostic, not secrets)", () => {
    expect(redact("tokens=1234")).toBe("tokens=1234")
    expect(redact("tokenizer=vocab.json")).toContain("tokenizer=")
  })

  test("redacts internal/local-domain emails but not npm version syntax", () => {
    expect(redact("from root@machine here")).toBe("from [email] here")
    expect(redact("ping alice@corp now")).toBe("ping [email] now")
    expect(redact("installed react@18.2.0 ok")).toBe("installed react@18.2.0 ok")
  })

  test("redacts a private key that was truncated before its END line", () => {
    expect(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAA")).toBe("[redacted-key]")
  })

  test("redacts PGP private key blocks (KEY BLOCK label) and empty-username basic-auth", () => {
    expect(redact("-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----")).toBe(
      "[redacted-key]",
    )
    expect(redact("url https://:plainsecretvalue@127.0.0.1/api")).not.toContain("plainsecretvalue")
  })

  test("redacts a bare multi-line base64 key body whose BEGIN header was truncated away", () => {
    // A pre-redaction log tail can strand a key body without its header; the body-shape rule catches it.
    const body = Array.from({ length: 8 }, () => "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3").join("\n")
    const out = redact(`some log line\n${body}\nmore log`)
    expect(out).not.toContain("MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3")
    expect(out).toContain("[redacted-key-body]")
    expect(out).toContain("some log line")
    expect(out).toContain("more log")
  })

  test("redacts a stranded key body after PGP armor / encrypted-PEM header lines", () => {
    // Header-agnostic: the body rule matches the base64 directly, so Version/Proc-Type lines don't shield it.
    const body = Array.from({ length: 8 }, () => "lQOYBFB2k3IBCADHmQE7AgEAAkEAq2u3MIIBVQIBADANBgkqhkiG9w0").join("\n")
    const pgp = redact(`Version: GnuPG v2\nComment: a comment\n\n${body}`)
    expect(pgp).toContain("[redacted-key-body]")
    expect(pgp).not.toContain("lQOYBFB2k3IBCADHmQE7AgEAAkEAq2u3MIIBVQIBADANBgkqhkiG9w0")
    const enc = redact(`Proc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,FEED\n\n${body}`)
    expect(enc).toContain("[redacted-key-body]")
  })

  test("redacts a CRLF base64 key body", () => {
    const body = Array.from({ length: 8 }, () => "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3").join("\r\n")
    expect(redact(body)).toContain("[redacted-key-body]")
  })

  test("redacts a single stranded body line terminated by an orphaned private-key END", () => {
    // BEGIN truncated away, only one full body line + a short line + END survive: the END signals a key,
    // so the body is redacted even though the multi-line block rule alone would not fire on one line.
    const full = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3"
    const out = redact([full, "AQAB", "-----END RSA PRIVATE KEY-----"].join("\n"))
    expect(out).toContain("[redacted-key]")
    expect(out).not.toContain(full)
    // A public certificate END is not a secret marker — its body is left intact.
    const cert = redact(["aGVsbG8gd29ybGQgZm9vYmFyYmF6", "-----END CERTIFICATE-----"].join("\n"))
    expect(cert).toContain("aGVsbG8gd29ybGQgZm9vYmFyYmF6")
  })

  test("redacts a body and END that share one physical line (newline-stripped serialization)", () => {
    const body = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3"
    const out = redact(`${body}-----END RSA PRIVATE KEY-----`)
    expect(out).toContain("[redacted-key]")
    expect(out).not.toContain(body)
  })

  test("redacts a stranded PGP body whose END is preceded by a =CRC checksum line", () => {
    // ASCII-armored PGP keys end the body with a "=<4 base64 chars>" CRC-24 line before the END.
    // That line starts with "=", so the body/short-line groups can't traverse it; the rule must hop it.
    const body = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3"
    const out = redact([body, "=aBcD", "-----END PGP PRIVATE KEY BLOCK-----"].join("\n"))
    expect(out).toContain("[redacted-key]")
    expect(out).not.toContain(body)
    // Armor headers above the body are not secret and stay; everything from the body through END goes.
    const armored = redact(
      ["Version: GnuPG v2", "", body, "=aBcD", "-----END PGP PRIVATE KEY BLOCK-----"].join("\n"),
    )
    expect(armored).toContain("Version: GnuPG v2")
    expect(armored).toContain("[redacted-key]")
    expect(armored).not.toContain(body)
  })

  test("redacts full body lines even when the last line is short (e.g. the AQAB exponent)", () => {
    // A PEM body's final line is usually < 16 chars; it must not prevent matching the full lines above it.
    const full = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3"
    const out = redact([full, full, full, "AQAB"].join("\n"))
    expect(out).toContain("[redacted-key-body]")
    expect(out).not.toContain(full)
  })

  test("does not redact a single base64 line or inline base64 (a kept token/hash stays diagnostic)", () => {
    // One base64 line is a token/id/hash; only a multi-line block is treated as a key body.
    const inline = "id MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7 done"
    expect(redact(inline)).toBe(inline)
    const single = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3"
    expect(redact(single)).toBe(single)
    // A following plain word is not swallowed into the block.
    expect(redact([single, single, "done note"].join("\n"))).toContain("done note")
  })

  test("does not backtrack on a long unbroken base64 run (no ReDoS)", () => {
    const huge = "A".repeat(300_000)
    const start = performance.now()
    redact(huge)
    expect(performance.now() - start).toBeLessThan(1_000)
  })

  test("redacts an over-long basic-auth password to an IP host (no length cap on the credential)", () => {
    const longPass = "S".repeat(300)
    expect(redact(`url https://user:${longPass}@127.0.0.1/api`)).not.toContain(longPass)
  })

  test("redacts URL userinfo in every form, including bare user@ to an IP host", () => {
    expect(redact("fetch https://ci-user:@127.0.0.1/api")).not.toContain("ci-user")
    expect(redact("fetch https://ci-user@127.0.0.1/api")).not.toContain("ci-user")
    expect(redact("fetch https://:plainsecret@127.0.0.1/api")).not.toContain("plainsecret")
  })

  test("redacts a quoted credential value containing an escaped quote", () => {
    // The quoted-value branch consumes escapes, so the tail after \" is not left behind.
    expect(redact('password="abc\\"tailsecretvalue"')).not.toContain("tailsecretvalue")
    expect(redact('clientSecret: "ab\\"cd\\"ef-secret-9"')).not.toContain("secret-9")
  })

  test("redacts cookie values in singular and plural forms", () => {
    expect(redact("Set-Cookie: sid=abc123private")).not.toContain("abc123private")
    expect(redact("request cookies: sid=abc123private")).not.toContain("abc123private")
  })

  test("redacts a JWT whose header has whitespace (encodes to eyA…, not eyJ…)", () => {
    const spaced = "eyAiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk"
    expect(redact(`token ${spaced} end`)).not.toContain(spaced)
  })

  test("does not backtrack on a long non-private BEGIN block", () => {
    // Regression: a bounded label charset keeps this near-instant instead of super-linear.
    const huge = `-----BEGIN ${"A".repeat(200_000)} PUBLIC KEY-----`
    const start = performance.now()
    redact(huge)
    expect(performance.now() - start).toBeLessThan(500)
  })

  test("redacts a 1-char username term as a whole word", () => {
    const oneChar = makeRedactor(["x"])
    expect(oneChar("user x did thing")).not.toContain(" x ")
    expect(oneChar("0x1f and example")).toBe("0x1f and example")
  })

  test("redacts absolute paths and the usernames in them", () => {
    for (const [name, path] of Object.entries(PATHS)) {
      expect(redact(`see ${path} now`), name).not.toContain(path)
    }
    expect(redact(`hello ${EMAIL}`)).toBe("hello [email]")
    expect(redact(`user is ${USERNAME} here`)).not.toContain(`${USERNAME} here`)
  })

  test("leaves ordinary text untouched", () => {
    expect(redact("line one\nline two")).toBe("line one\nline two")
    expect(redact("/session/ses_1")).toBe("/session/ses_1")
  })

  test("matches extra terms case-insensitively", () => {
    expect(redact(`user ALICE logged in`)).not.toContain("ALICE")
    expect(redact(`path /HOME/ALICE/x`)).not.toContain("ALICE")
  })

  test("redacts a 2-char username as a whole word but not inside other words", () => {
    const shortUser = makeRedactor(["yu"])
    expect(shortUser("logged in as yu today")).not.toContain("as yu ")
    expect(shortUser("the yuan dropped")).toBe("the yuan dropped")
  })

  test("drops empty / whitespace-only terms", () => {
    const empty = makeRedactor(["", "   "])
    expect(empty("grab a cab")).toBe("grab a cab")
  })

  test("redacts short non-ASCII usernames that JS \\b word boundaries miss", () => {
    // JS \b is an ASCII word boundary: \b张\b never matches, so a 1–2 char CJK/JP username would
    // leak. These must be redacted as exact terms instead.
    expect(makeRedactor(["山田"])("user 山田 failed")).toBe("user [user] failed")
    expect(makeRedactor(["张"])("user 张 failed")).toBe("user [user] failed")
    expect(makeRedactor(["张三"])("at /home/张三/x and 张三 again")).not.toContain("张三")
    // The ASCII whole-word sparing still holds (regression guard for the boundary split).
    expect(makeRedactor(["x"])("0x1f and example")).toBe("0x1f and example")
    expect(makeRedactor(["yu"])("the yuan dropped")).toBe("the yuan dropped")
  })
})

describe("sanitizeSessionMessages", () => {
  const redact = makeRedactor([])

  test("keeps allowlisted structure and omits the system prompt", () => {
    const [message] = sanitizeSessionMessages(
      [
        {
          info: { id: "m1", sessionID: "s", role: "user", time: { created: 1 }, agent: "build", system: "SYSTEM_PROMPT" },
          parts: [{ id: "p1", type: "text", text: "hello world" }],
        },
      ],
      { redact },
    ) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>

    expect(message.info.role).toBe("user")
    expect(message.info.id).toBe("m1")
    expect(message.info.agent).toBe("build")
    expect(message.info).not.toHaveProperty("system")
    expect(message.parts[0]).toEqual({ type: "text", bytes: 11, text: "hello world" })
  })

  test("caps oversized part bodies but records true byte size", () => {
    const big = "x".repeat(SESSION_PART_TEXT_MAX_CHARS + 5_000)
    const [message] = sanitizeSessionMessages(
      [{ info: { role: "assistant" }, parts: [{ type: "text", text: big }] }],
      { redact },
    ) as Array<{ parts: Array<{ bytes: number; text: string }> }>

    expect(message.parts[0].bytes).toBe(big.length)
    expect(message.parts[0].text.length).toBeLessThanOrEqual(SESSION_PART_TEXT_MAX_CHARS + 40)
    expect(message.parts[0].text).toContain("chars]")
  })

  test("allowlists tool parts and drops file content", () => {
    const [message] = sanitizeSessionMessages(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "webfetch",
              callID: "c1",
              state: { status: "completed", input: { url: "https://x" }, output: "fetched body" },
            },
            {
              type: "file",
              mime: "text/plain",
              filename: "notes.md",
              url: "data:text/plain;base64,SECRETBODY",
              source: { type: "file", path: "/home/alice/notes.md", text: { value: "FILE_CONTENT_LEAK" } },
            },
          ],
        },
      ],
      { redact },
    ) as Array<{ parts: Array<Record<string, unknown>> }>

    expect(message.parts[0]).toMatchObject({ type: "tool", tool: "webfetch", status: "completed", output: "fetched body" })
    expect(JSON.stringify(message.parts[1])).not.toContain("FILE_CONTENT_LEAK")
    expect(JSON.stringify(message.parts[1])).not.toContain("SECRETBODY")
  })

  test("redacts secrets that appear as tool-input object keys", () => {
    const [message] = sanitizeSessionMessages(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "exec",
              callID: "c1",
              state: {
                status: "completed",
                input: { [`env ${TOKENS.anthropic}`]: "value", path: PATHS.posix },
                output: "ok",
              },
            },
          ],
        },
      ],
      { redact: makeRedactor([USERNAME]) },
    ) as Array<{ parts: Array<Record<string, unknown>> }>

    const serialized = JSON.stringify(message.parts[0])
    expect(serialized).not.toContain(TOKENS.anthropic)
    expect(serialized).not.toContain(PATHS.posix)
  })

  test("redacts a bare secret value carried under a sensitive field name", () => {
    // No prefix/shape for the scrubber to catch — the field name is the only signal.
    const [message] = sanitizeSessionMessages(
      [
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "tool",
              tool: "exec",
              callID: "c1",
              state: {
                status: "completed",
                input: {
                  apiKey: "plain1234value5678",
                  clientSecret: "nopattern9999",
                  // Suffix-matched names with no fixed-list entry — caught by the *Token/*Key suffix.
                  apiToken: "vendortoken4321",
                  sshKey: "rawkeymaterial8888",
                  harmless: "keep-me",
                },
                output: "ok",
              },
            },
          ],
        },
      ],
      { redact: makeRedactor([]) },
    ) as Array<{ parts: Array<{ input: string }> }>

    expect(message.parts[0].input).not.toContain("plain1234value5678")
    expect(message.parts[0].input).not.toContain("nopattern9999")
    expect(message.parts[0].input).not.toContain("vendortoken4321")
    expect(message.parts[0].input).not.toContain("rawkeymaterial8888")
    expect(message.parts[0].input).toContain("keep-me")
  })

  test("keeps token-usage counts (a 'tokens' field is not an auth token)", () => {
    const [message] = sanitizeSessionMessages(
      [{ info: { role: "assistant", tokens: { input: 12, output: 34 } }, parts: [] }],
      { redact: makeRedactor([]) },
    ) as Array<{ info: { tokens: { input: number; output: number } } }>
    expect(message.info.tokens).toEqual({ input: 12, output: 34 })
  })

  test("drops the parts of a system-role message (the system prompt)", () => {
    const [message] = sanitizeSessionMessages(
      [{ info: { role: "system" }, parts: [{ type: "text", text: "SYSTEM PROMPT BODY" }] }],
      { redact },
    ) as Array<{ info: { role: string }; parts: unknown[]; omitted?: string }>
    expect(message.info.role).toBe("system")
    expect(message.parts).toEqual([])
    expect(message.omitted).toBe("system-prompt")
    expect(JSON.stringify(message)).not.toContain("SYSTEM PROMPT BODY")
  })

  test("reports unknown message shapes instead of passing them through", () => {
    const [message] = sanitizeSessionMessages([{ body: "raw leak", token: TOKENS.github }], { redact }) as Array<{
      unrecognized: boolean
    }>
    expect(message).toMatchObject({ unrecognized: true })
    expect(JSON.stringify(message)).not.toContain("raw leak")
    expect(JSON.stringify(message)).not.toContain(TOKENS.github)
  })

  test("shape-tokens a file part source path even under a non-allowlisted root", () => {
    const [message] = sanitizeSessionMessages(
      [
        {
          info: { role: "user" },
          parts: [{ type: "file", source: { type: "file", path: "/customroot/alice/secret-plan.pdf" } }],
        },
      ],
      { redact: makeRedactor([]) },
    ) as Array<{ parts: Array<{ source_path?: string }> }>
    expect(message.parts[0].source_path).toBe("[path]")
    expect(JSON.stringify(message)).not.toContain("customroot")
    expect(JSON.stringify(message)).not.toContain("secret-plan")
  })
})

describe("sanitizeSessionInfo", () => {
  const redact = makeRedactor([])

  test("allowlists metadata, caps the title, and drops content-heavy fields", () => {
    const info = sanitizeSessionInfo(
      {
        id: "ses_1",
        slug: "my-session",
        version: "1.2.3",
        title: "user typed title",
        directory: PATHS.posix,
        summary: { additions: 3, deletions: 1, files: 2, diffs: [{ leak: "CODE_DIFF_CONTENT" }] },
        revert: { messageID: "m9", partID: "p1", diff: "REVERT_DIFF_CONTENT", snapshot: "SNAP" },
        permission: { rules: ["SECRET_RULE"] },
        share: { url: "https://share.example/abc" },
        unknownField: "DROP_ME",
      },
      { redact },
    ) as Record<string, unknown>

    expect(info.id).toBe("ses_1")
    expect(info.title).toBe("user typed title")
    expect(info.directory).toBe("[path]")
    expect(info.summary).toEqual({ additions: 3, deletions: 1, files: 2 })
    expect(info.revert).toEqual({ messageID: "m9", partID: "p1" })
    expect(info).not.toHaveProperty("permission")
    expect(info).not.toHaveProperty("share")
    expect(info).not.toHaveProperty("unknownField")
    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain("CODE_DIFF_CONTENT")
    expect(serialized).not.toContain("REVERT_DIFF_CONTENT")
    expect(serialized).not.toContain("SECRET_RULE")
    expect(serialized).not.toContain("DROP_ME")
  })

  test("allowlists executionContext: shape-tokens every path, keeps worktree name/branch, drops unknown", () => {
    const info = sanitizeSessionInfo(
      {
        id: "ses_1",
        executionContext: {
          ownerDirectory: "/customroot/alice/owner",
          activeDirectory: "/customroot/alice/active",
          activeWorktree: {
            directory: "/customroot/alice/wt",
            name: "acme-worktree",
            branch: "main",
            source: "created",
            extra: "DROP_WT_FIELD",
          },
          lastChangedAt: 123,
          build: "DROP_BUILD",
          nested: { leak: "/customroot/alice/leak" },
        },
      },
      { redact: makeRedactor([]) },
    ) as Record<string, unknown>

    expect(info.executionContext).toEqual({
      ownerDirectory: "[path]",
      activeDirectory: "[path]",
      activeWorktree: { directory: "[path]", name: "acme-worktree", branch: "main", source: "created" },
      lastChangedAt: 123,
    })
    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain("customroot")
    expect(serialized).not.toContain("DROP_BUILD")
    expect(serialized).not.toContain("DROP_WT_FIELD")
  })
})

describe("buildProblemReport redaction gate", () => {
  test("the full uploaded report contains no seeded secret, path, username, or email", () => {
    // A private-key body whose BEGIN header was stranded outside a pre-redaction log-tail truncation.
    const strandedKeyBody = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEAq2u3leiyKeyBody"
    const logTail = [
      `anthropic ${TOKENS.anthropic}`,
      `aws ${TOKENS.aws} google ${TOKENS.google}`,
      `gitlab ${TOKENS.gitlab} github ${TOKENS.github} hf ${TOKENS.huggingface} npm ${TOKENS.npm}`,
      `slack ${TOKENS.slack} stripe ${TOKENS.stripe}`,
      `jwt ${TOKENS.jwt}`,
      `Authorization: Bearer ${TOKENS.bearer}`,
      `password="${TOKENS.password}"`,
      `url https://${USERNAME}:${TOKENS.basicPass}@internal.example.com/api`,
      `email ${EMAIL}`,
      `paths ${Object.values(PATHS).join(" ")}`,
      strandedKeyBody,
      strandedKeyBody,
      strandedKeyBody,
      strandedKeyBody,
    ].join("\n")

    const report = buildProblemReport(
      {
        diagnostics: validDiagnostics(),
        logTail,
        sessionExport: {
          status: "ok",
          info: { id: "ses_1", directory: PATHS.home },
          messages: [
            {
              info: { id: "m1", sessionID: "ses_1", role: "user", time: { created: 1 }, system: TOKENS.anthropic },
              parts: [
                { type: "text", text: `prompt with ${TOKENS.jwt} and ${EMAIL}` },
                {
                  type: "tool",
                  tool: "webfetch",
                  callID: "c1",
                  state: {
                    status: "completed",
                    input: { url: `https://${USERNAME}:${TOKENS.basicPass}@host`, path: PATHS.win },
                    output: `body ${TOKENS.aws} ${TOKENS.stripe}`,
                  },
                },
                {
                  type: "file",
                  mime: "text/plain",
                  filename: PATHS.win,
                  url: "data:text/plain;base64,x",
                  source: { type: "file", path: PATHS.posix, text: { value: TOKENS.github } },
                },
              ],
            },
            { body: "freeform", apiKey: TOKENS.gitlab },
          ],
        },
        rendererDiagnostics: {
          status: "ok",
          source: "renderer-diagnostics",
          generated_at: "2026-06-22T01:02:03.004Z",
          events: [
            {
              time: "2026-06-22T01:02:03.004Z",
              level: "info",
              "event.name": "incident.test",
              app_launch_id: "al1",
              window_id: "w1",
              // Top-level event ID strings must be scrubbed too, not just `data`.
              trace_id: TOKENS.stripe,
              route_session_id: EMAIL,
              // Secret in a value, and a path used as a data key — both must be scrubbed.
              data: { note: `reach ${EMAIL} token ${TOKENS.npm}`, [PATHS.tilde]: "seen" },
            },
          ],
          summary: {
            event_count: 1,
            incident_count: 1,
            // A secret-shaped status only disappears if summary is scrubbed too, not just events.
            statuses: ["ok", "sk-ant-statusleak0000000000000000" as unknown as "ok"],
            omitted_event_count: 0,
            omitted_bytes: 0,
          },
        },
        // `extra` is not part of RendererErrorDetails; the untyped IPC boundary could still send it.
        // It must be dropped, not spread into the payload.
        rendererError: {
          summary: `renderer failed password="${TOKENS.password}"`,
          details: `${PATHS.unc} ${PATHS.file} ${PATHS.tilde} ${EMAIL}`,
          extra: "extra-field-secret-7f3a",
        } as { summary: string; details: string },
      },
      { reportId: "pwr_redact", generatedAt: "2026-06-22T01:02:03.004Z", redactTerms: [USERNAME, "/home/alice"] },
    )

    const samples = [...Object.values(TOKENS), ...Object.values(PATHS), USERNAME, EMAIL]
    for (const sample of samples) {
      expect(report.markdown, sample).not.toContain(sample)
    }
    // A bare key body stranded in the log tail (header truncated away) is scrubbed end-to-end.
    expect(report.markdown).not.toContain(strandedKeyBody)
    // The rogue rendererError field was dropped, not carried through.
    expect(report.markdown).not.toContain("extra-field-secret-7f3a")
    // The renderer summary (not just events) is scrubbed.
    expect(report.markdown).not.toContain("sk-ant-statusleak0000000000000000")
    // The report is still a valid, parseable payload after redaction.
    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.sessionExport.status).toBe("ok")
  })

  test("shape-tokens diagnostics directory and logPath even under a non-allowlisted root", () => {
    // The path regex only catches allowlisted roots; a project under a custom mount would otherwise
    // leak its directory/project name. These fields are known paths, so they map to [path] wholesale.
    const report = buildProblemReport(
      {
        diagnostics: validDiagnostics({
          directory: "/customroot/alice/project",
          logPath: "/customroot/alice/logs/main.log",
        }),
        logTail: "",
        sessionExport: { status: "none" },
      },
      { reportId: "pwr_custompath", generatedAt: "2026-06-22T01:02:03.004Z" },
    )

    const payload = parseProblemReportPayload(report.markdown)
    expect(payload.diagnostics.directory).toBe("[path]")
    expect(payload.diagnostics.logPath).toBe("[path]")
    expect(report.markdown).not.toContain("customroot")
  })

  test("scrubs a non-string rendererError field arriving from the untyped IPC boundary", () => {
    const report = buildProblemReport(
      {
        diagnostics: validDiagnostics(),
        logTail: "",
        sessionExport: { status: "none" },
        // summary is typed string but the IPC boundary could send an object carrying a secret.
        rendererError: { summary: { nested: TOKENS.anthropic }, details: "ok" } as unknown as {
          summary: string
          details: string
        },
      },
      { reportId: "pwr_nonstring", generatedAt: "2026-06-22T01:02:03.004Z" },
    )
    expect(report.markdown).not.toContain(TOKENS.anthropic)
  })
})
