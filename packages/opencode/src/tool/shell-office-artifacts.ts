const officeOutputExtensions = new Set([".docx", ".xlsx", ".pptx", ".pdf"])

type Segment = {
  text: string
  delimiter?: string
}

export function isOfficeOutputPath(file: string) {
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
