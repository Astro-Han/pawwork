// A local MCP `command` is an argv array (`["node", "/p/My server.js"]`) passed
// straight to the stdio transport — it never goes through a shell. The form edits
// it as one space-separated line for the common paste-a-command case, so the
// split/join here must be lossless: ANY argv the config holds — including one
// that contains spaces (a path) or both quote characters (a `node -e` / `sh -c`
// payload) — has to survive an edit round-trip instead of being chopped apart.
//
// Grammar: whitespace separates argv. Double quotes protect inner whitespace and
// support `\"` / `\\` escapes, so any character is representable. Single quotes
// protect inner whitespace with no escapes. `splitCommand(joinCommand(argv))`
// is the identity for every argv (proven by the round-trip tests).

function needsQuote(arg: string): boolean {
  return arg === "" || /[\s"'\\]/.test(arg)
}

export function joinCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => (needsQuote(arg) ? `"${arg.replace(/[\\"]/g, "\\$&")}"` : arg))
    .join(" ")
}

export function splitCommand(input: string): string[] {
  const argv: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let started = false
  let escaped = false
  for (const ch of input) {
    if (quote === '"') {
      if (escaped) {
        cur += ch
        escaped = false
      } else if (ch === "\\") escaped = true
      else if (ch === '"') quote = null
      else cur += ch
      continue
    }
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        argv.push(cur)
        cur = ""
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  // A trailing backslash inside a double quote had nothing to escape; keep it literal.
  if (escaped) {
    cur += "\\"
    started = true
  }
  if (started) argv.push(cur)
  return argv
}
