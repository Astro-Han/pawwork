// Internal shell-kind taxonomy. NOT a public rename of the bash tool.
// The exposed tool id, schema name, and permission key all remain "bash" for
// backward compatibility with saved permissions, plugins, and existing config.
// This module only labels the shell kind internally so prompts and per-shell
// logic can branch cleanly.

const kinds = ["bash", "pwsh", "powershell", "cmd"] as const

export type Kind = (typeof kinds)[number]

const kindSet = new Set<string>(kinds)

export function isKind(value: string): value is Kind {
  return kindSet.has(value)
}

export function toKind(value: string): Kind {
  return isKind(value) ? value : "bash"
}

// Public tool id and permission key — keep as "bash" indefinitely.
export const ToolID = "bash"
export type ToolID = typeof ToolID

export * as BashID from "./id"
