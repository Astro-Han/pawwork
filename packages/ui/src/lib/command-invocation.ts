import type { FilePart, Part, TextPart } from "@opencode-ai/sdk/v2"

export type CommandSource = "skill" | "mcp" | "command"

const VALID_SOURCES: readonly CommandSource[] = ["skill", "mcp", "command"]
const DEFAULT_ICON = "command"
const DISPLAY_ARGS_MAX = 80

export interface CommandInvocation {
  name: string
  source: CommandSource
  markIcon: string
  displayLabel: string
  args: string
  copyText: string
  restoreText: string
  forkPreviewText: string
  suppressTextPartIds: readonly string[]
  suppressFilePartIds: readonly string[]
}

interface RawCommandInvocation {
  name: string
  source?: unknown
  icon?: unknown
  args?: unknown
  displayArgs?: unknown
}

export function isCommandInvocationMetadata(meta: unknown): meta is { commandInvocation: RawCommandInvocation } {
  if (!meta || typeof meta !== "object") return false
  const candidate = (meta as { commandInvocation?: unknown }).commandInvocation
  if (!candidate || typeof candidate !== "object") return false
  const name = (candidate as { name?: unknown }).name
  return typeof name === "string" && name.length > 0
}

function normaliseSource(value: unknown): CommandSource {
  return typeof value === "string" && (VALID_SOURCES as readonly string[]).includes(value)
    ? (value as CommandSource)
    : "command"
}

function normaliseIcon(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_ICON
}

function normaliseArgs(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

function normaliseDisplayArgs(value: unknown, args: string): string {
  if (typeof value === "string" && value.length > 0) return value
  return truncate(args, DISPLAY_ARGS_MAX)
}

export function deriveCommandInvocation(parts: readonly Part[]): CommandInvocation | null {
  let host: TextPart | undefined
  let raw: RawCommandInvocation | undefined
  for (const p of parts) {
    if (p.type !== "text") continue
    const meta = (p as TextPart & { metadata?: unknown }).metadata
    if (!isCommandInvocationMetadata(meta)) continue
    raw = meta.commandInvocation
    host = p as TextPart
    break
  }
  if (!host || !raw) return null

  const name = raw.name
  const source = normaliseSource(raw.source)
  const markIcon = normaliseIcon(raw.icon)
  const args = normaliseArgs(raw.args)
  const displayArgs = normaliseDisplayArgs(raw.displayArgs, args)

  // displayLabel is the in-bubble rendered text. The icon visually replaces the slash,
  // so the bubble shows `<icon> <name>` (no leading `/`). Copy / restore / fork-preview
  // keep the `/` because those are plain-text contexts where the slash carries semantic
  // meaning (re-trigger the command, identify it in a text-only list).
  const displayLabel = name
  const slashLiteral = "/" + name
  const copyText = args.length > 0 ? slashLiteral + " " + args : slashLiteral
  const restoreText = args.length > 0 ? slashLiteral + " " + args : slashLiteral + " "
  const forkPreviewText = displayArgs.length > 0 ? slashLiteral + " " + displayArgs : slashLiteral

  const suppressTextPartIds: string[] = [host.id]
  const suppressFilePartIds: string[] = []
  for (const p of parts) {
    if (p.type !== "file") continue
    const meta = (p as FilePart & { metadata?: { commandTemplate?: unknown } }).metadata
    if (meta?.commandTemplate === true) suppressFilePartIds.push(p.id)
  }

  return {
    name,
    source,
    markIcon,
    displayLabel,
    args,
    copyText,
    restoreText,
    forkPreviewText,
    suppressTextPartIds,
    suppressFilePartIds,
  }
}

export function isCommandMessage(parts: readonly Part[]): boolean {
  return deriveCommandInvocation(parts) !== null
}
