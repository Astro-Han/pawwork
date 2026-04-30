import os from "os"
import type { Permission } from "./index"

export type DenialSuggestion = {
  platform?: NodeJS.Platform
  applicability: "retryable" | "ask_user"
  text: string
}

export type AdditionalBlockedCommand = {
  blockedCommand: string
  matchedRule: Permission.Rule
}

export type DenialDiagnostic = {
  code: "permission.bash.permanent_delete_blocked" | "permission.bash.denied"
  category: "permanent_delete" | "generic"
  blockedCommand: string
  matchedRule: Permission.Rule
  reason: string
  suggestions: DenialSuggestion[]
  additionalBlockedCommands?: AdditionalBlockedCommand[]
}

const PERMANENT_DELETE_RULE_PATTERNS = [
  /^rm(?:\s|$)/,
  /^rmdir(?:\s|$)/,
  /^unlink(?:\s|$)/,
  /^find(?:\s|$).*(?:^|\s)-delete(?:\*|\s|$)/,
  /^Remove-Item(?:\s|$)/i,
  /^del(?:\s|$)/i,
  /^erase(?:\s|$)/i,
  /^rd(?:\s|$)/i,
]

export function isPermanentDeleteRule(rule: Permission.Rule) {
  const pattern = rule.pattern.trim()
  return PERMANENT_DELETE_RULE_PATTERNS.some((matcher) => matcher.test(pattern))
}

export function fromDeniedRule(input: {
  permission: string
  blockedCommand: string
  matchedRule: Permission.Rule
  platform?: NodeJS.Platform
  additionalBlockedCommands?: AdditionalBlockedCommand[]
}): DenialDiagnostic | undefined {
  if (input.permission !== "bash") return undefined

  if (isPermanentDeleteRule(input.matchedRule)) {
    return withAdditional(input, {
      code: "permission.bash.permanent_delete_blocked",
      category: "permanent_delete",
      blockedCommand: input.blockedCommand,
      matchedRule: input.matchedRule,
      reason: "This command permanently deletes files and is not reversible.",
      suggestions: permanentDeleteSuggestions(input.platform ?? os.platform()),
    })
  }

  return withAdditional(input, {
    code: "permission.bash.denied",
    category: "generic",
    blockedCommand: input.blockedCommand,
    matchedRule: input.matchedRule,
    reason: "This command is blocked by PawWork's safety policy.",
    suggestions: [
      {
        applicability: "ask_user",
        text: "Do not retry with another destructive command. Explain what you were trying to do and ask the user before proceeding.",
      },
    ],
  })
}

function withAdditional(
  input: { additionalBlockedCommands?: AdditionalBlockedCommand[] },
  diagnostic: DenialDiagnostic,
): DenialDiagnostic {
  if (!input.additionalBlockedCommands?.length) return diagnostic
  return {
    ...diagnostic,
    additionalBlockedCommands: input.additionalBlockedCommands,
  }
}

export function permanentDeleteSuggestions(platform: NodeJS.Platform): DenialSuggestion[] {
  if (platform === "darwin") {
    return [
      {
        platform,
        applicability: "retryable",
        text: "Use a reversible trash command instead. On macOS, run `command -v trash`, then use `trash <path>` if available.",
      },
      {
        platform,
        applicability: "ask_user",
        text: "If no reversible trash command is available, ask the user before changing system state or deleting permanently.",
      },
    ]
  }

  if (platform === "linux") {
    return [
      {
        platform,
        applicability: "retryable",
        text: "Use a reversible trash command instead. On Linux, run `command -v gio`, then use `gio trash <path>` if available.",
      },
      {
        platform,
        applicability: "retryable",
        text: "If `gio` is unavailable, check `command -v trash-put` and use `trash-put <path>` if available.",
      },
      {
        platform,
        applicability: "ask_user",
        text: "If no reversible trash command is available, ask the user before changing system state or deleting permanently.",
      },
    ]
  }

  if (platform === "win32") {
    return [
      {
        platform,
        applicability: "ask_user",
        text: "Do not use `Remove-Item` as a reversible replacement. PowerShell has no simple built-in recycle cmdlet; ask the user or use an app-level reversible delete path. Windows Recycle Bin support exists through .NET `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` or `DeleteDirectory` with `RecycleOption.SendToRecycleBin`, but that is not a simple shell replacement.",
      },
    ]
  }

  return [
    {
      applicability: "ask_user",
      text: "No reversible trash command is known for this platform. Ask the user before changing system state or deleting permanently.",
    },
  ]
}

export function render(diagnostic: DenialDiagnostic): string {
  const lines = [
    `Command blocked: ${diagnostic.blockedCommand}`,
    `Reason: ${diagnostic.reason}`,
    `Matched rule: ${diagnostic.matchedRule.permission} "${diagnostic.matchedRule.pattern}" ${diagnostic.matchedRule.action}`,
  ]

  if (diagnostic.additionalBlockedCommands?.length) {
    const commands = diagnostic.additionalBlockedCommands
      .map((command) => command.blockedCommand)
      .join(", ")
    lines.push(`Additional blocked commands (${diagnostic.additionalBlockedCommands.length}): ${commands}`)
  }

  lines.push("", "Recommended next step:", ...diagnostic.suggestions.map((suggestion) => suggestion.text))
  return lines.join("\n")
}
