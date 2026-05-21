const writeCommands = new Set(["cp", "mv", "rm", "mkdir", "touch", "tee", "yarn", "npm", "bun", "pnpm", "patch"])

const powershellWriteCommands =
  /\b(set-content|new-item|remove-item|copy-item|move-item|out-file|add-content|clear-content|rename-item)\b/i

function withoutQuotedText(command: string) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
}

function commandWords(command: string) {
  return command
    .split(/&&|\|\||[;|]/)
    .flatMap((part) => part.trim().split(/\s+/).filter(Boolean))
    .map((word) => word.toLowerCase())
}

export function isLikelyWriteCommand(command: string) {
  if (powershellWriteCommands.test(command)) return true

  const stripped = withoutQuotedText(command)
  if (/(^|\s)(?!\d*>\s*&\d)\d*>>?\s*[^&\s]/.test(stripped)) return true

  const words = commandWords(stripped)
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (writeCommands.has(word)) return true
    if (word === "sed" && words.slice(index + 1, index + 4).some((item) => item === "-i" || item.startsWith("-i")))
      return true
    if (word === "cargo" && words[index + 1] === "build") return true
    if (word === "go" && words[index + 1] === "build") return true
    if (
      word === "git" &&
      ["checkout", "switch", "apply", "merge", "rebase", "reset", "commit"].includes(words[index + 1] ?? "")
    )
      return true
  }
  return false
}
