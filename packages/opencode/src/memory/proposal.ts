import { MemoryFile } from "./memory"

const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bpassword\s*[:=]\s*\S+/gi,
]

export namespace MemoryProposal {
  export type Proposal = {
    id: string
    text: string
    scope: MemoryFile.Scope
    defaultSelected: boolean
    warning?: string
  }

  export function redact(input: string) {
    let text = input
    let highRisk = false
    for (const pattern of SENSITIVE_PATTERNS) {
      pattern.lastIndex = 0
      if (pattern.test(text)) highRisk = true
      pattern.lastIndex = 0
      text = text.replace(pattern, "[REDACTED]")
    }
    return { text, highRisk }
  }

  export function fromText(input: { text: string; scope?: MemoryFile.Scope }): Proposal {
    const redacted = redact(input.text)
    return {
      id: MemoryFile.makeID(),
      text: redacted.text,
      scope: input.scope ?? "project",
      defaultSelected: !redacted.highRisk,
      warning: redacted.highRisk ? "Contains possible sensitive data." : undefined,
    }
  }
}
