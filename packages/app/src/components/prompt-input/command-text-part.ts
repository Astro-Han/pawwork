import type { CommandSource, TextPart } from "@/context/prompt"

export interface CommandDescriptor {
  name: string
  source: CommandSource
  icon: string
}

// Regex: `/^\/(\S+)(?: ([\s\S]*))?$/` (no flags per spec).
// Separator must be exactly one ASCII space. Tab/newline do NOT match.
const COMMAND_REGEX = /^\/(\S+)(?: ([\s\S]*))?$/

// Detect whether a string is pure ASCII (code points 0x00-0x7F).
// Only pure-ASCII paths get case-insensitive matching to preserve
// `command.name.length === inputName.length` byte-for-byte for caret math.
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return false
  }
  return true
}

// ASCII-only lowercase: replace A-Z with a-z without Unicode case-folding.
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

// Match a typed name against the registry.
// Both sides must be pure ASCII for case-insensitive comparison; otherwise
// exact byte match is required (no Unicode case-folding).
function matchRegistry(
  typedName: string,
  registry: ReadonlyArray<CommandDescriptor>,
): CommandDescriptor | null {
  const typedAscii = isAscii(typedName)
  for (const entry of registry) {
    const entryAscii = isAscii(entry.name)
    if (typedAscii && entryAscii) {
      if (asciiLower(typedName) === asciiLower(entry.name)) return entry
    } else {
      if (typedName === entry.name) return entry
    }
  }
  return null
}

// Create a marked TextPart for a command. Content is always `/<name> <args>`;
// trailing space is present even when args is empty string.
export function createCommandTextPart(cmd: CommandDescriptor, args: string): TextPart {
  const content = `/${cmd.name} ${args}`
  return {
    type: "text",
    content,
    start: 0,
    end: content.length,
    command: { name: cmd.name, source: cmd.source, icon: cmd.icon },
  }
}

// Try to parse rawText as a leading command from the registry.
// Returns a marked TextPart using the registry's canonical casing, or null
// when the text does not match the regex or the name is not registered.
export function tryParseLeadingCommandFromText(
  rawText: string,
  registry: ReadonlyArray<CommandDescriptor>,
): TextPart | null {
  const match = rawText.match(COMMAND_REGEX)
  if (!match) return null
  const typedName = match[1]
  // Regex requires \S+ so typedName can't be empty, but guard for safety.
  if (!typedName) return null
  const entry = matchRegistry(typedName, registry)
  if (!entry) return null
  // match[2] is the args group (everything after the single separator space).
  // When there is no separator space in the input, match[2] is undefined → use "".
  const args = match[2] ?? ""
  return createCommandTextPart(entry, args)
}

// Build a CommandDescriptor[] registry from sync.data.command entries.
// sync.data.command provides {name, source?}; source defaults to "command"
// when absent. icon always defaults to "command" (resolveCommandIconSvg
// fallback). Built-in slash commands are NOT included — they dispatch
// immediately, never rendered as pills.
export function buildSlashRegistry(
  commands: ReadonlyArray<{ name: string; source?: CommandSource }>,
): CommandDescriptor[] {
  return commands.map((c) => ({
    name: c.name,
    source: c.source ?? "command",
    icon: "command",
  }))
}

// Synchronous invariant check. Throws when the marked TextPart violates the
// content prefix contract (`/<name> ` must be the start of content).
// Used by helper-level Bun tests; production renderer should use reportInvariantBreach.
export function assertCommandTextPart(part: TextPart): void {
  const cmd = part.command
  if (!cmd) {
    throw new Error("command-text-part invariant: missing command metadata")
  }
  const prefix = `/${cmd.name} `
  if (!part.content.startsWith(prefix)) {
    throw new Error(
      `command-text-part invariant: content "${part.content}" does not start with "${prefix}"`,
    )
  }
}
