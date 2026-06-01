const officeOutputExtensions = new Set([".docx", ".xlsx", ".pptx"])
const officeCliWriteCommands = new Set(["add", "close", "create", "import", "move", "raw-set", "remove", "set", "swap"])
const officeCliBatchWriteCommands = new Set(["add", "add-part", "move", "raw-set", "remove", "set", "swap"])

type Segment = {
  text: string
  delimiter?: string
}

export function isOfficeCliOutputPath(file: string) {
  const match = file.match(/\.([^.\\/]+)$/)
  return officeOutputExtensions.has(match?.[0].toLowerCase() ?? "")
}

export function commandSegments(command: string) {
  const segments: Segment[] = []
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
    const currentDelimiter =
      char === "\n" || char === "\r"
        ? char
        : char === "&" && next === "&"
        ? "&&"
        : char === "|" && next === "|"
          ? "||"
          : char === ";" || char === "|"
            ? char
            : undefined
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

export function tokenWords(command: string) {
  return commandSegments(command)
    .map((segment) => shellWords(segment.text).map((word) => word.toLowerCase()))
    .filter((words) => words.length > 0)
}

export function nonOfficeCliCommandText(command: string) {
  return commandSegments(command)
    .filter((segment) => {
      const words = shellWords(segment.text).map((word) => word.toLowerCase())
      const { head } = commandHead(words)
      return !head || !isOfficeCli(head)
    })
    .map((segment) => segment.text)
    .join("; ")
}

export function commandHead(words: string[]) {
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
  return { head: words[index], next: words[index + 1], rest: words.slice(index + 1), index }
}

export function isOfficeCli(head: string) {
  return head === "officecli" || head === "officecli.exe"
}

export function isOfficeCliWriteCommand(command: string | undefined) {
  return officeCliWriteCommands.has(command ?? "")
}

export function hasMutatingOfficeCliBatchCommand(segment: string) {
  if (!/(?:^|\s)--commands(?:=|\s)/i.test(segment)) return false
  for (const match of segment.matchAll(/["'](?:command|op)["']\s*:\s*["']([^"']+)["']/gi)) {
    if (officeCliBatchWriteCommands.has(match[1].toLowerCase())) return true
  }
  return false
}

export function hasOfficeCliBatchDynamicInput(segment: Segment) {
  const hasInput = segment.delimiter === "|" || /(?:^|\s)<{1,2}\s*\S/.test(segment.text)
  if (!hasInput) return false

  const words = shellWords(segment.text)
  const { head, next, index } = commandHead(words.map((word) => word.toLowerCase()))
  if (!head || !isOfficeCli(head) || next !== "batch") return false
  const target = firstPathArgument(words.slice(index + 2))
  if (!target) return false
  return isDynamicTarget(target)
}

export function officeCliTargets(command: string) {
  const paths: string[] = []
  for (const segment of commandSegments(command)) {
    const words = shellWords(segment.text)
    const lowered = words.map((word) => word.toLowerCase())
    const { head, next, index } = commandHead(lowered)
    if (!head || !isOfficeCli(head)) continue

    if (next === "batch" || isOfficeCliWriteCommand(next)) {
      const target = firstPathArgument(words.slice(index + 2))
      if (target && isStaticOfficeTarget(target)) paths.push(target)
    }
  }
  return Array.from(new Set(paths))
}

function firstPathArgument(words: string[]) {
  for (const word of words) {
    if (!word) continue
    if (word.startsWith("-")) return
    return word
  }
}

function isStaticOfficeTarget(file: string) {
  return !isDynamicTarget(file) && isOfficeCliOutputPath(file)
}

function isDynamicTarget(file: string) {
  return file.includes("$") || file.includes("%") || file.includes("`") || file.includes("$(") || file.includes("${")
}

function shellWords(text: string) {
  const words: string[] = []
  let current = ""
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === quote) {
        quote = undefined
        continue
      }
      if (char === "\\" && quote === '"' && index + 1 < text.length) {
        index++
        current += text[index]
        continue
      }
      current += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) words.push(current)
  return words
}
