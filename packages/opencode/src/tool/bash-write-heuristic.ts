const writeCommands = new Set([
  "apply_patch",
  "bun",
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "make",
  "mkdir",
  "mv",
  "npm",
  "patch",
  "pip",
  "pnpm",
  "rm",
  "tee",
  "touch",
  "truncate",
  "tsc",
  "uv",
  "vite",
  "yarn",
])

const powershellWriteCommands =
  /\b(set-content|new-item|remove-item|copy-item|move-item|out-file|add-content|clear-content|rename-item)\b/i

function withoutQuotedText(command: string) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
}

function commandSegments(command: string) {
  return command
    .split(/&&|\|\||[;|]/)
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word.toLowerCase()),
    )
    .filter((words) => words.length > 0)
}

function commandHead(words: string[]) {
  let index = 0
  while (true) {
    const word = words[index]
    if (!word) break
    if (word.includes("=") && !word.startsWith("-") && !word.startsWith("=")) {
      index++
      continue
    }
    if (["command", "sudo", "env"].includes(word)) {
      index++
      continue
    }
    break
  }
  return { head: words[index], next: words[index + 1], rest: words.slice(index + 1) }
}

export function isLikelyWriteCommand(command: string) {
  if (powershellWriteCommands.test(command)) return true

  const stripped = withoutQuotedText(command)
  if (/(^|\s)(?!\d*>\s*&\d)\d*>>?\s*[^&\s]/.test(stripped)) return true

  for (const words of commandSegments(stripped)) {
    const { head, next, rest } = commandHead(words)
    if (!head) continue
    if (writeCommands.has(head)) return true
    if (head === "sed" && rest.slice(0, 3).some((item) => item === "-i" || item.startsWith("-i"))) return true
    if (head === "perl" && rest.slice(0, 3).some((item) => item.includes("i"))) return true
    if (head === "awk" && rest.join(" ").includes("-i inplace")) return true
    if (head === "cargo" && next === "build") return true
    if (head === "go" && ["build", "get"].includes(next ?? "")) return true
    if (
      head === "git" &&
      [
        "add",
        "apply",
        "checkout",
        "cherry-pick",
        "clean",
        "commit",
        "merge",
        "rebase",
        "reset",
        "restore",
        "stash",
        "switch",
      ].includes(next ?? "")
    )
      return true
  }
  return false
}
