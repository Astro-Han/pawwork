import {
  commandHead,
  commandSegments as rawCommandSegments,
  hasMutatingOfficeCliBatchCommand,
  hasOfficeCliBatchDynamicInput,
  isOfficeCli,
  isOfficeCliWriteCommand,
  tokenWords,
} from "./bash-office-artifacts"

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

function withoutQuotedText(command: string) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""')
}

function commandSegments(command: string) {
  return tokenWords(command)
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
      (hasMutatingOfficeCliBatchCommand(rawSegment.text) || hasOfficeCliBatchDynamicInput(rawSegment))
    )
      return true
    if (isOfficeCli(head) && isOfficeCliWriteCommand(next)) return true
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
