// Strip secrets and local identifiers from a problem report before it leaves the machine.
//
// Two regimes, by data shape (see docs/architecture/2026-06-22-diagnostics-package-design.md §2):
//   - Free text (logs, error details, message text): a blacklist scrubber. Logs are not
//     structured, so allowlisting is impossible; we redact known credential and path shapes.
//   - Session messages: a field allowlist mirroring the renderer-diagnostics paradigm. The
//     /session/{id}/message payload is structured, so we keep role/time/part-type/tool-name/
//     byte-size + per-part length-capped body, redact the kept text, and omit unknown fields.
//
// The blacklist is best-effort by nature (it covers common, enumerable secret shapes, not every
// possible one); user-authored content is kept and gated by the in-app review step, not redaction.

export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]

export type Redactor = (value: string) => string

// Per-part body cap so a single message never dominates the report and review stays meaningful.
// PR2 layers cross-component total budgets on top of this fixed per-part limit.
export const SESSION_PART_TEXT_MAX_CHARS = 4_000

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8")
}

export function toJsonSafe(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return String(value)
  if (typeof value !== "object") return String(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.map((item) => toJsonSafe(item, seen))
    seen.delete(value)
    return result
  }
  const result: { [key: string]: JsonValue } = {}
  for (const [key, nested] of Object.entries(value)) result[key] = toJsonSafe(nested, seen)
  seen.delete(value)
  return result
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Credential shapes, most specific first. Each runs over a single text value; path patterns are
// line-greedy on purpose (a local path or its trailing context should not survive on its log line).
const SECRET_REPLACERS: Array<(value: string) => string> = [
  // PEM/PGP private key blocks. The label charset is bounded ([A-Z0-9 ]{0,40}) so non-matching input
  // (e.g. a huge "-----BEGIN <200k chars> PUBLIC KEY-----") fails fast instead of backtracking across
  // the whole string. Covers RSA/EC/OPENSSH PRIVATE KEY and PGP PRIVATE KEY BLOCK. The END line is
  // optional: a truncated log tail may keep only the BEGIN marker + partial body, so consume to END
  // when present, else to end of string.
  (v) =>
    v.replace(
      /-----BEGIN[A-Z0-9 ]{0,40}PRIVATE[A-Z0-9 ]{0,40}-----[\s\S]*?(?:-----END[A-Z0-9 ]{0,40}-----|$)/g,
      "[redacted-key]",
    ),
  // Bare multi-line base64 block (the wrapped body of a PEM/PGP key). The BEGIN-keyed rule above only
  // fires when the header is present, but a pre-redaction truncation of an unbounded log (logging.ts
  // byte/line tail) can strand a key body without its BEGIN — leaving headerless base64 the rule misses.
  // Matching the body shape directly is header-agnostic: it covers a body stranded after armor lines
  // (PGP Version/Comment, encrypted-PEM Proc-Type/DEK-Info), with or without an END, and CRLF logs. The
  // run is >= 2 WHOLE lines of only base64 (>= 16 chars each), so a single base64 line (a token/hash/id
  // kept for diagnostics) and inline base64 (a quoted literal) are untouched. Every MATCHED line needs
  // >= 16 chars so a trailing word ("done") is never eaten; the line-start anchor plus the per-line
  // length floor keep it linear (no catastrophic backtracking on a long non-base64 run). This runs
  // before the orphan-END rule so a long body is consumed here as one match, not chewed line by line.
  (v) =>
    v.replace(
      /(^|\n)(?:[A-Za-z0-9+/]{16,}={0,2}\r?\n){1,}[A-Za-z0-9+/]{16,}={0,2}(?=\r?\n|$)/g,
      "$1[redacted-key-body]",
    ),
  // Orphaned private-key END: the BEGIN rule consumed every complete BEGIN..END block, so a surviving
  // "-----END ... PRIVATE ... -----" had its BEGIN truncated away. Redact the contiguous body above it
  // through the END — this catches even a SINGLE stranded body line that the >= 2-line block rule misses
  // (the END is the signal). The body can be preceding whole lines, a short final line, an optional PGP
  // "=CRC" checksum line, and a same-physical-line base64 run right before the END (a log that serialized
  // the key without a newline between body and END). Anchored at a line start with per-line length floors
  // so it stays linear; only a PRIVATE END triggers it (a public CERTIFICATE body is not secret), and a
  // real private-key END never follows unrelated base64, so the body match cannot eat legitimate content.
  (v) =>
    v.replace(
      /(^|\n)(?:[A-Za-z0-9+/]{16,}={0,2}\r?\n)*(?:[A-Za-z0-9+/]{1,}={0,2}\r?\n)?(?:=[A-Za-z0-9+/]{1,6}\r?\n)?[ \t]*[A-Za-z0-9+/]*={0,2}[ \t]*-----END[A-Z0-9 ]{0,40}PRIVATE[A-Z0-9 ]{0,40}-----/g,
      "$1[redacted-key]",
    ),
  // URL basic-auth credentials. The username is optional ([^/@\s:]*) so `scheme://:pass@host` and
  // IP hosts are covered, not only `scheme://user:pass@host`. ONLY the scheme length is bounded
  // ([a-z0-9+.-]{0,40}): the scheme is unanchored, so an unbounded greedy run scans for "://" from
  // every letter and goes quadratic on a long letter run. The credential parts run after "://" is
  // already matched (one anchored O(n) pass), so they are left unbounded — a length cap there would
  // let an over-long password slip past the rule entirely. The whole `:password` part is optional, so
  // every userinfo form redacts: `user:pass@`, `:pass@`, `user:@`, and bare `user@` (the last leaks
  // the username otherwise, since the email rule skips IP hosts that have no letter in the domain).
  (v) => v.replace(/([a-z][a-z0-9+.-]{0,40}:\/\/)[^/@\s:]*(?::[^/@\s]*)?@/gi, "$1[redacted]@"),
  // JWT (header.payload.signature). Anchored on "ey" (base64 of "{…") rather than "eyJ", so a header
  // with whitespace after the brace (encodes to "eyA…") is still caught.
  (v) => v.replace(/\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-token]"),
  // Known provider token prefixes. The sk- class allows hyphen/underscore segments so newer
  // OpenAI/OpenRouter keys (sk-proj-…, sk-or-v1-…) are caught, not just classic sk- keys.
  (v) =>
    v.replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|glpat-[0-9A-Za-z_-]{16,}|gh[posru]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|hf_[0-9A-Za-z]{16,}|npm_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|[rs]k_live_[0-9A-Za-z]{16,})\b/g,
      "[redacted-token]",
    ),
  // Authorization / Proxy-Authorization headers: redact the whole credential after the scheme.
  // The generic key=value rule below stops at the scheme word ("Basic"), leaking the base64 that
  // follows, so this fully-consuming header rule must run first.
  (v) =>
    v.replace(
      /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:basic|bearer|digest|negotiate)\s+[^\s"',;]+/gi,
      "$1$2[redacted]",
    ),
  // Bearer tokens.
  (v) => v.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"),
  // Named credential assignments. The [\w-]* wrappers catch vendor-prefixed / camelCase names
  // (AWS_SECRET_ACCESS_KEY, clientSecret, accessToken) that plain \b boundaries miss; token(?!s|ize)
  // avoids eating "tokens=" usage counts and "tokenizer=" config. The quoted value branches consume
  // escapes ((?:[^"\\]|\\.)*) so a value containing an escaped quote (password="abc\"…", common in
  // JSON-in-logs) is redacted whole, not just up to the first inner quote.
  (v) =>
    v.replace(
      /\b([\w-]*(?:password|passwd|pwd|passphrase|secret|token(?!s|ize)|api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?secret|session[_-]?token|credential)[\w-]*)(["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|["']?[^\s"',;&}\])]{4,})/gi,
      "$1$2[redacted]",
    ),
  // Bare "storage"/"key" assignments — kept word-bounded so "monkey"/"keyboard" are not redacted.
  (v) => v.replace(/\b(storage|key)\b(["']?\s*[:=]\s*["']?)[^\s"',;&}\])]{4,}/gi, "$1$2[redacted]"),
  // Cookies. `cookies?` covers the plural / "request cookies:" forms, not just the singular header.
  (v) => v.replace(/\b(set-cookies?|cookies?)\b(["']?\s*[:=]\s*)[^\n\r]+/gi, "$1$2[redacted]"),
  // Absolute paths and the usernames embedded in them.
  (v) => v.replace(/[A-Za-z]:\\[^\r\n"']*/g, "[path]"),
  (v) => v.replace(/\\\\[^\\\s"']+\\[^\r\n"']*/g, "[path]"),
  (v) => v.replace(/file:\/\/\/?[^\s"'<>]*/gi, "[path]"),
  // ~ or ~username followed by a path.
  (v) => v.replace(/~[^\s/\\"']*[\\/][^\r\n"']*/g, "[path]"),
  // Absolute POSIX paths under a common system/home/dev root. The leading directory is allowlisted
  // (a fully general "/a/b" rule would shred URLs and route strings); the user's home dir and
  // username are additionally redacted as exact terms, so an out-of-list root never leaks identity.
  (v) =>
    v.replace(
      /\/(?:Users|home|root|tmp|opt|srv|etc|usr|var|mnt|media|private|Applications|Library|System|Network|Volumes|bin|sbin|dev|run|proc|lib|lib64|boot|sys|nix|workspace|data|snap|host)[\\/][^\r\n"']*/g,
      "[path]",
    ),
  // (No general "any path ending in filename.ext" rule: it over-redacted diagnostic URLs/routes and
  // had a super-linear backtracking path. Non-allowlisted-root paths carry no identity — the username
  // and home dir are redacted as exact terms — so they fall under the documented best-effort residual,
  // backstopped by in-app human review. See the design doc §2.2 known-boundaries note.)
  // Email addresses, including internal/local domains (alice@corp, root@host). The lookahead
  // requires a letter in the domain so npm version syntax (react@18.2.0) is not mistaken for email.
  (v) => v.replace(/\b[A-Za-z0-9._%+-]+@(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\b/g, "[email]"),
]

// Build a free-text redactor. `extraTerms` are exact strings known to be sensitive at runtime
// (the OS username, the home directory) — the surest way to catch a bare username that no regex
// can infer. Short terms are dropped to avoid nuking common substrings.
export function makeRedactor(extraTerms: string[] = []): Redactor {
  const terms = Array.from(
    new Set(extraTerms.map((term) => (typeof term === "string" ? term.trim() : "")).filter((term) => term.length >= 1)),
  )
  // Case-insensitive so a username cased differently in a path than in os.userInfo() still matches.
  // A short (1–2 char) ASCII-word username matches only as a whole word, sparing single letters
  // embedded in other tokens (the "x" in "0x1f", the "yu" in "yuan"). But JS `\b` is an ASCII word
  // boundary: a short non-ASCII username ("张"/"山田") has no `\b` next to it and would leak, so it
  // is redacted as an exact term instead. (Terms of length >2 were always exact.)
  const termPatterns = terms.map((term) => {
    const escaped = escapeRegExp(term)
    const shortAsciiWord = /^[A-Za-z0-9_]{1,2}$/.test(term)
    return new RegExp(shortAsciiWord ? `\\b${escaped}\\b` : escaped, "gi")
  })
  return (value: string) => {
    if (typeof value !== "string" || value.length === 0) return value
    let next = value
    // Pattern shapes first (email/path matches stay intact), then exact terms catch any bare
    // username the regexes could not infer.
    for (const replace of SECRET_REPLACERS) next = replace(next)
    for (const pattern of termPatterns) next = next.replace(pattern, "[user]")
    return next
  }
}

// Field names that mark their value as a secret regardless of its shape. A bare value
// (`{ apiKey: "plain-token" }`) carries no pattern for the string scrubber to match, so the field
// name is the only signal. Substring matches are normalized (case-folded, separators stripped) so
// `AWS_SECRET_ACCESS_KEY`, `clientSecret`, and `accessToken` all hit; exact matches cover short
// ambiguous names without catching their plurals/compounds (`token` yes, `tokens`/`tokenizer` no).
const SENSITIVE_KEY_SUBSTRING =
  /password|passphrase|passwd|secret|apikey|accesskey|secretkey|privatekey|signingkey|sshkey|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken|apitoken|bearertoken|bottoken|clientsecret|apisecret|credential|authorization|cookie/
// Suffix match catches the open-ended vendor space (apiToken, botToken, sshKey, signingKey) that no
// fixed list can enumerate. `token$` deliberately does not match "tokens"/"tokenizer" — those are
// usage counts / config, not auth tokens, and are diagnostically useful.
const SENSITIVE_KEY_SUFFIX = /(?:token|key|secret|password|passphrase|credential)$/
const SENSITIVE_KEY_EXACT = new Set(["token", "key", "auth", "pwd", "bearer", "secret", "password"])
function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, "")
  if (normalized === "tokens" || normalized === "tokenizer") return false
  return (
    SENSITIVE_KEY_EXACT.has(normalized) ||
    SENSITIVE_KEY_SUFFIX.test(normalized) ||
    SENSITIVE_KEY_SUBSTRING.test(normalized)
  )
}

// Deep-redact an already-json-safe value. Used for structured data (session info, tool input
// objects, error objects). Three guarantees: every string leaf runs through the scrubber, object
// keys are scrubbed too (a key can itself be a secret/path), and a sensitive field name redacts its
// whole value wholesale (the bare value would otherwise slip past every pattern).
export function redactJsonValue(value: JsonValue, redact: Redactor): JsonValue {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redact))
  if (value && typeof value === "object") {
    const result: { [key: string]: JsonValue } = {}
    for (const [key, nested] of Object.entries(value)) {
      result[redact(key)] = isSensitiveKey(key) ? "[redacted]" : redactJsonValue(nested, redact)
    }
    return result
  }
  return value
}

type SanitizeContext = {
  redact: Redactor
  textMax: number
}

function redactCap(value: string, ctx: SanitizeContext): string {
  const redacted = ctx.redact(value)
  if (redacted.length <= ctx.textMax) return redacted
  return `${redacted.slice(0, ctx.textMax)}…[+${redacted.length - ctx.textMax} chars]`
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function structuredText(value: unknown, ctx: SanitizeContext): { bytes: number; text: string } | undefined {
  if (value === undefined) return undefined
  const json = JSON.stringify(redactJsonValue(toJsonSafe(value), ctx.redact)) ?? ""
  return { bytes: byteLength(json), text: json.length <= ctx.textMax ? json : `${json.slice(0, ctx.textMax)}…` }
}

function sanitizePart(part: unknown, ctx: SanitizeContext): JsonValue {
  if (!isObject(part)) return { unrecognized: true }
  const type = stringField(part.type) ?? "unknown"
  const out: { [key: string]: JsonValue } = { type }

  const textBody = (raw: unknown) => {
    const text = stringField(raw) ?? ""
    out.bytes = byteLength(text)
    out.text = redactCap(text, ctx)
  }

  switch (type) {
    case "text":
    case "reasoning":
      textBody(part.text)
      break
    case "tool": {
      if (part.tool !== undefined) out.tool = stringField(part.tool) ?? null
      const state = isObject(part.state) ? part.state : {}
      if (state.status !== undefined) out.status = stringField(state.status) ?? null
      const input = structuredText(state.input, ctx)
      const output = stringField(state.output)
      const error = stringField(state.error)
      out.bytes = (input?.bytes ?? 0) + byteLength(output ?? "") + byteLength(error ?? "")
      if (input) out.input = input.text
      if (output !== undefined) out.output = redactCap(output, ctx)
      if (error !== undefined) out.error = redactCap(error, ctx)
      break
    }
    case "file": {
      if (part.mime !== undefined) out.mime = stringField(part.mime) ?? null
      if (part.filename !== undefined) out.filename = ctx.redact(String(part.filename))
      const source = isObject(part.source) ? part.source : undefined
      const sourceText = isObject(source?.text) ? stringField(source.text.value) : undefined
      out.bytes = byteLength(stringField(part.url) ?? "") + byteLength(sourceText ?? "")
      // A file source path is a known filesystem path: shape-token it wholesale rather than letting
      // the free-text scrubber guess (it only catches allowlisted roots, so a non-listed root leaks).
      if (source && source.path !== undefined) out.source_path = "[path]"
      break
    }
    case "subtask": {
      if (part.agent !== undefined) out.agent = stringField(part.agent) ?? null
      if (part.status !== undefined) out.status = stringField(part.status) ?? null
      if (part.description !== undefined) out.description = redactCap(String(part.description), ctx)
      if (part.result_summary !== undefined) out.result_summary = redactCap(String(part.result_summary), ctx)
      out.bytes =
        byteLength(stringField(part.prompt) ?? "") +
        byteLength(stringField(part.result_text) ?? "") +
        byteLength(stringField(part.partial_result) ?? "")
      break
    }
    case "patch":
      if (typeof part.hash === "string") out.hash = part.hash
      if (Array.isArray(part.files)) out.files = part.files.map((file) => ctx.redact(String(file)))
      break
    case "step-finish":
      if (typeof part.reason === "string") out.reason = part.reason
      if (typeof part.cost === "number") out.cost = part.cost
      if (part.tokens !== undefined) out.tokens = toJsonSafe(part.tokens)
      break
    case "agent":
    case "skill":
      if (part.name !== undefined) out.name = stringField(part.name) ?? null
      break
    case "retry": {
      if (typeof part.attempt === "number") out.attempt = part.attempt
      const error = structuredText(part.error, ctx)
      if (error) out.error = error.text
      break
    }
    case "notice":
      if (typeof part.kind === "string") out.kind = part.kind
      if (typeof part.sideEffect === "boolean") out.sideEffect = part.sideEffect
      break
    case "compaction":
      if (typeof part.auto === "boolean") out.auto = part.auto
      if (typeof part.overflow === "boolean") out.overflow = part.overflow
      break
    default:
      // step-start, snapshot, source-url, and unknown types: keep only the type tag.
      break
  }
  return out
}

function sanitizeMessageInfo(info: unknown, ctx: SanitizeContext): JsonValue {
  if (!isObject(info)) return {}
  const out: { [key: string]: JsonValue } = {}
  if (typeof info.role === "string") out.role = info.role
  if (typeof info.id === "string") out.id = info.id
  if (info.time !== undefined) out.time = toJsonSafe(info.time)
  if (typeof info.agent === "string") out.agent = info.agent
  if (typeof info.providerID === "string") out.providerID = info.providerID
  if (typeof info.modelID === "string") out.modelID = info.modelID
  if (isObject(info.model)) {
    out.model = {
      providerID: stringField(info.model.providerID) ?? null,
      modelID: stringField(info.model.modelID) ?? null,
    }
  }
  if (typeof info.cost === "number") out.cost = info.cost
  if (info.tokens !== undefined) out.tokens = toJsonSafe(info.tokens)
  if (typeof info.finish === "string") out.finish = info.finish
  if (typeof info.automationID === "string") out.automationID = info.automationID
  // Absolute working-directory paths — keep the shape, drop the value.
  if (info.path !== undefined) out.path = "[path]"
  if (info.error !== undefined) {
    const error = structuredText(info.error, ctx)
    if (error) out.error = error.text
  }
  if (isObject(info.summary) && typeof info.summary.title === "string") {
    out.summary_title = redactCap(info.summary.title, ctx)
  }
  // Omitted on purpose: system (system prompt), structured output, tools map, raw summary body.
  return out
}

// Structure-aware allowlist for the session executionContext object. Every directory/worktree field
// is a known path, so paths map to the [path] shape token wholesale — never guessed by the free-text
// scrubber, which only catches allowlisted roots and would leak a path under a non-listed root or a
// newly added field. Unknown fields are dropped, not spread through. Worktree name/branch are kept
// (capped + scrubbed) as low-risk diagnostic identifiers.
function sanitizeExecutionContext(value: Record<string, unknown>, ctx: SanitizeContext): JsonValue {
  const out: { [key: string]: JsonValue } = {}
  if (value.ownerDirectory !== undefined) out.ownerDirectory = "[path]"
  if (value.activeDirectory !== undefined) out.activeDirectory = "[path]"
  if (isObject(value.activeWorktree)) {
    const worktree = value.activeWorktree
    const worktreeOut: { [key: string]: JsonValue } = {}
    if (worktree.directory !== undefined) worktreeOut.directory = "[path]"
    if (worktree.name !== undefined) worktreeOut.name = redactCap(String(worktree.name), ctx)
    if (worktree.branch !== undefined) worktreeOut.branch = redactCap(String(worktree.branch), ctx)
    if (worktree.source !== undefined) worktreeOut.source = stringField(worktree.source) ?? null
    out.activeWorktree = worktreeOut
  }
  if (typeof value.lastChangedAt === "number") out.lastChangedAt = value.lastChangedAt
  return out
}

// Structure-aware allowlist for the top-level session info object, mirroring the message-info
// discipline: keep metadata scalars, cap the user-authored title, map working directories to a
// shape token, and drop content-heavy fields (diffs, revert diff/snapshot, permission ruleset, the
// share URL) rather than scrubbing them in place. Unknown fields never pass through.
export function sanitizeSessionInfo(info: unknown, options: { redact: Redactor; textMax?: number }): JsonValue {
  const ctx: SanitizeContext = { redact: options.redact, textMax: options.textMax ?? SESSION_PART_TEXT_MAX_CHARS }
  if (!isObject(info)) return redactJsonValue(toJsonSafe(info), ctx.redact)
  const out: { [key: string]: JsonValue } = {}
  for (const key of ["id", "slug", "projectID", "workspaceID", "parentID", "subagentType", "skill", "version"]) {
    const value = stringField(info[key])
    if (value !== undefined) out[key] = value
  }
  if (typeof info.createdByAgentTool === "boolean") out.createdByAgentTool = info.createdByAgentTool
  if (info.title !== undefined) out.title = redactCap(String(info.title), ctx)
  // Working-directory paths — keep the shape, drop the value.
  if (info.directory !== undefined) out.directory = "[path]"
  if (info.time !== undefined) out.time = toJsonSafe(info.time)
  if (isObject(info.summary)) {
    out.summary = {
      additions: typeof info.summary.additions === "number" ? info.summary.additions : null,
      deletions: typeof info.summary.deletions === "number" ? info.summary.deletions : null,
      files: typeof info.summary.files === "number" ? info.summary.files : null,
    }
  }
  if (isObject(info.executionContext)) {
    out.executionContext = sanitizeExecutionContext(info.executionContext, ctx)
  }
  if (isObject(info.revert) && typeof info.revert.messageID === "string") {
    out.revert = { messageID: info.revert.messageID }
    if (typeof info.revert.partID === "string") out.revert.partID = info.revert.partID
  }
  // Final uniform pass: scrub every kept metadata string (id/slug/projectID/…) too, so the guarantee
  // does not hinge on which scalar was copied — matching the whole-tree pass on session messages.
  return redactJsonValue(out, ctx.redact)
}

// Structure-aware allowlist for session export messages. Unknown shapes are reported, never
// passed through, so a non-{info,parts} payload cannot smuggle raw content into the report.
export function sanitizeSessionMessages(messages: unknown[], options: { redact: Redactor; textMax?: number }): JsonValue[] {
  const ctx: SanitizeContext = { redact: options.redact, textMax: options.textMax ?? SESSION_PART_TEXT_MAX_CHARS }
  return messages.map((message): JsonValue => {
    if (!isObject(message)) return { unrecognized: true }
    if (message.info === undefined && message.parts === undefined) {
      return { unrecognized: true, bytes: byteLength(JSON.stringify(toJsonSafe(message)) ?? "") }
    }
    // A system-role message is the system prompt; drop its parts entirely (only the role survives),
    // matching the omission of the User.system field elsewhere.
    if (isObject(message.info) && stringField(message.info.role) === "system") {
      return { info: { role: "system" }, parts: [], omitted: "system-prompt" }
    }
    // The allowlist selects which fields survive and caps their bodies; this final pass guarantees
    // every surviving string (including kept enums/IDs and any key) goes through the scrubber, so a
    // leak can never hinge on whether one specific field was redacted at selection time.
    return redactJsonValue(
      {
        info: sanitizeMessageInfo(message.info, ctx),
        parts: Array.isArray(message.parts) ? message.parts.map((part) => sanitizePart(part, ctx)) : [],
      },
      ctx.redact,
    )
  })
}
