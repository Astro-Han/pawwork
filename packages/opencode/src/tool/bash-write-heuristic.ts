const writeCommands = new Set([
  "apply_patch",
  "chmod",
  "chown",
  "cp",
  "dd",
  "install",
  "ln",
  "make",
  "mkdir",
  "mv",
  "patch",
  "rm",
  "rmdir",
  "tee",
  "touch",
  "truncate",
  "yarn",
])

const powershellWriteCommands =
  /\b(set-content|new-item|remove-item|copy-item|move-item|out-file|add-content|clear-content|rename-item)\b/i
const officeCliWriteCommands = new Set([
  "add",
  "batch",
  "close",
  "create",
  "import",
  "move",
  "raw-set",
  "remove",
  "set",
  "swap",
])

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

function isOfficeCli(head: string) {
  return head === "officecli" || head === "officecli.exe"
}

export function isLikelyWriteCommand(command: string) {
  for (const words of commandSegments(command)) {
    const { head } = commandHead(words)
    if (["powershell", "pwsh"].includes(head ?? "") && powershellWriteCommands.test(command)) return true
  }

  const stripped = withoutQuotedText(command)
  if (powershellWriteCommands.test(stripped)) return true
  if (/(^|\s)(?:&>>?|\d*>\||\d*<>|(?<!<)\d*>>?)\s*[^&\s]/.test(stripped)) return true

  for (const words of commandSegments(stripped)) {
    const { head, next, rest } = commandHead(words)
    if (!head) continue
    if (isOfficeCli(head) && officeCliWriteCommands.has(next ?? "")) return true
    if (writeCommands.has(head)) return true
    if (head === "sed" && rest.slice(0, 3).some((item) => item === "-i" || item.startsWith("-i"))) return true
    if (head === "perl" && rest.slice(0, 3).some((item) => item.includes("i"))) return true
    if (head === "awk" && rest.join(" ").includes("-i inplace")) return true
    if (head === "cargo" && ["add", "build", "install", "run"].includes(next ?? "")) return true
    if (head === "go" && ["build", "get", "install"].includes(next ?? "")) return true
    if (["bun", "npm", "pnpm", "yarn"].includes(head) && [undefined, "add", "build", "i", "install"].includes(next))
      return true
    if (["bun", "npm", "pnpm", "yarn"].includes(head) && next === "run" && ["build", "compile"].includes(rest[1] ?? ""))
      return true
    if (head === "cmake" && next === "--build") return true
    if (["python", "python3"].includes(head) && next === "setup.py") return true
    if (head === "pip" && ["install", "uninstall"].includes(next ?? "")) return true
    if (head === "uv" && ["add", "remove", "sync"].includes(next ?? "")) return true
    if (head === "uv" && next === "pip" && ["install", "uninstall"].includes(rest[1] ?? "")) return true
    if (head === "vite" && next === "build") return true
    if (head === "tsc" && !rest.some((item) => item === "--noemit")) return true
    if (
      head === "git" &&
      [
        "add",
        "apply",
        "checkout",
        "cherry-pick",
        "clean",
        "commit",
        "clone",
        "fetch",
        "merge",
        "mv",
        "pull",
        "rebase",
        "reset",
        "restore",
        "revert",
        "rm",
        "stash",
        "switch",
      ].includes(next ?? "")
    )
      return true
  }
  return false
}
