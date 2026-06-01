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
  "close",
  "create",
  "import",
  "move",
  "raw-set",
  "remove",
  "set",
  "swap",
])
const officeCliBatchWriteCommands = new Set(["add", "add-part", "move", "raw-set", "remove", "set", "swap"])

function withoutQuotedText(command: string) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
}

function rawCommandSegments(command: string) {
  const segments: Array<{ text: string; delimiter?: string }> = []
  let start = 0
  let delimiter: string | undefined
  let quote: "'" | '"' | undefined
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = undefined
      if (char === "\\" && quote === '"') index++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    const next = command[index + 1]
    const currentDelimiter = char === "&" && next === "&" ? "&&" : char === "|" && next === "|" ? "||" : char === ";" || char === "|" ? char : undefined
    if (!currentDelimiter) continue

    const text = command.slice(start, index).trim()
    if (text) segments.push({ text, delimiter })
    delimiter = currentDelimiter
    index += currentDelimiter.length - 1
    start = index + 1
  }
  const text = command.slice(start).trim()
  if (text) segments.push({ text, delimiter })
  return segments
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

function hasMutatingOfficeCliBatchCommand(segment: string) {
  if (!/(?:^|\s)--commands(?:=|\s)/i.test(segment)) return false
  for (const match of segment.matchAll(/["'](?:command|op)["']\s*:\s*["']([^"']+)["']/gi)) {
    if (officeCliBatchWriteCommands.has(match[1].toLowerCase())) return true
  }
  return false
}

function isOfficePath(path: string) {
  return /\.(docx|pptx|xlsx)(?:["']?)$/i.test(path)
}

function hasOfficeCliBatchStdin(rawSegment: { text: string; delimiter?: string }) {
  const hasInput = rawSegment.delimiter === "|" || /(?:^|\s)<{1,2}\s*\S/.test(rawSegment.text)
  if (!hasInput) return false

  const target = rawSegment.text.match(/\bofficecli(?:\.exe)?\s+batch\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i)
  if (!target) return false
  const path = target[1] ?? target[2] ?? target[3] ?? ""
  if (isOfficePath(path)) return true
  return path.includes("$") || path.includes("%")
}

export function isLikelyWriteCommand(command: string) {
  for (const words of commandSegments(command)) {
    const { head } = commandHead(words)
    if (["powershell", "pwsh"].includes(head ?? "") && powershellWriteCommands.test(command)) return true
  }

  const stripped = withoutQuotedText(command)
  if (powershellWriteCommands.test(stripped)) return true
  if (/(^|\s)(?:&>>?|\d*>\||\d*<>|(?<!<)\d*>>?)\s*[^&\s]/.test(stripped)) return true

  const rawSegments = rawCommandSegments(command)
  const strippedSegments = commandSegments(stripped)
  for (let index = 0; index < strippedSegments.length; index++) {
    const words = strippedSegments[index]
    const { head, next, rest } = commandHead(words)
    if (!head) continue
    const rawSegment = rawSegments[index]
    if (
      isOfficeCli(head) &&
      next === "batch" &&
      rawSegment &&
      (hasMutatingOfficeCliBatchCommand(rawSegment.text) || hasOfficeCliBatchStdin(rawSegment))
    )
      return true
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
