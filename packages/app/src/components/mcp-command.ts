// A local MCP `command` is an argv array (`["node", "/p/My server.js"]`) passed
// straight to the stdio transport — it never goes through a shell. The form edits
// it as one space-separated line for the common paste-a-command case, so the
// split/join here must be lossless: a single argv that contains spaces (e.g. a
// path) has to survive an edit round-trip instead of being chopped apart.
//
// Grammar is deliberately minimal: whitespace separates argv; single or double
// quotes protect inner whitespace and are consumed. There is no backslash
// escaping, so an argv that contains BOTH quote characters is not representable —
// that does not occur for real MCP commands and is left unhandled by design.

function needsQuote(arg: string): boolean {
  return arg === "" || /[\s"']/.test(arg)
}

export function joinCommand(argv: readonly string[]): string {
  return argv
    .map((arg) => {
      if (!needsQuote(arg)) return arg
      if (!arg.includes('"')) return `"${arg}"`
      if (!arg.includes("'")) return `'${arg}'`
      return `"${arg}"`
    })
    .join(" ")
}

export function splitCommand(input: string): string[] {
  const argv: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
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
  if (started) argv.push(cur)
  return argv
}
