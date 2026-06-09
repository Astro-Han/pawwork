import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const COMPONENT_DIR = dirname(fileURLToPath(import.meta.url))
const MESSAGE_PART_DIR = join(COMPONENT_DIR, "message-part")

const expectedParts = ["compaction", "notice", "reasoning", "text", "tool"]
const expectedTools = [
  "read",
  "list",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "enter-worktree",
  "exit-worktree",
  "task",
  "agent",
  "bash",
  "edit",
  "write",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) return sourceFiles(full)
      if (stat.isFile() && /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) return [full]
      return []
    })
    .sort()
}

function readMessagePartSources() {
  return [
    readFileSync(join(COMPONENT_DIR, "message-part.tsx"), "utf8"),
    readFileSync(join(COMPONENT_DIR, "assistant-turn-footer.tsx"), "utf8"),
    ...sourceFiles(MESSAGE_PART_DIR).map((file) => readFileSync(file, "utf8")),
  ].join("\n")
}

function readToolSource(file: string) {
  return readFileSync(join(MESSAGE_PART_DIR, "tools", file), "utf8")
}

test("message-part internals do not import through the facade", () => {
  const offenders = sourceFiles(MESSAGE_PART_DIR)
    .map((file) => ({
      file: relative(COMPONENT_DIR, file),
      text: readFileSync(file, "utf8"),
    }))
    .filter((item) => /from\s+["'](?:\.\.\/message-part|\.\.\/\.\.\/message-part)["']/.test(item.text))

  expect(offenders).toEqual([])
})

test("message-part registry stays independent from render modules", () => {
  const source = readFileSync(join(MESSAGE_PART_DIR, "registry.ts"), "utf8")
  const imports = [...source.matchAll(/import(?:\s+type)?(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g)].map(
    (match) => match[1],
  )
  const renderModuleImports = imports.filter(
    (path) => path === "./message-router" || path.startsWith("./parts") || path.startsWith("./tools"),
  )

  expect(renderModuleImports).toEqual([])
})

test("part and tool side-effect barrels cover every registered renderer", () => {
  const partsIndex = readFileSync(join(MESSAGE_PART_DIR, "parts", "index.ts"), "utf8")
  const toolsIndex = readFileSync(join(MESSAGE_PART_DIR, "tools", "index.ts"), "utf8")
  const source = readMessagePartSources()

  for (const part of expectedParts) {
    expect(source).toContain(`registerPartComponent("${part}"`)
  }

  for (const tool of expectedTools) {
    expect(source).toContain(`name: "${tool}"`)
  }

  for (const path of ["./compaction-and-divider", "./notice", "./reasoning", "./text", "./tool"]) {
    expect(partsIndex).toContain(`import "${path}"`)
  }

  for (const path of [
    "./read",
    "./list",
    "./glob",
    "./grep",
    "./webfetch",
    "./websearch",
    "./worktree",
    "./agent",
    "./bash",
    "./edit",
    "./write",
    "./apply-patch",
    "./todowrite",
    "./question",
    "./skill",
  ]) {
    expect(toolsIndex).toContain(`import "${path}"`)
  }
})

test("split keeps hidden tools and deferred heavy tool bodies explicit", () => {
  const source = readMessagePartSources()

  expect(source).toContain("export const HIDDEN_TOOLS = new Set<string>(HIDDEN_TOOL_NAMES)")
  expect(source).toContain('if (tool === "edit" || tool === "write" || tool === "apply_patch") return edit')
  expect(source).toContain("defaultOpen={props.defaultOpen ?? completed()}")

  const deferredHeavyTools = {
    "bash.tsx": 1,
    "edit.tsx": 1,
    "write.tsx": 1,
    "apply-patch.tsx": 1,
  } as const

  for (const [file, count] of Object.entries(deferredHeavyTools)) {
    expect([...readToolSource(file).matchAll(/\bdefer\b/g)].length).toBe(count)
  }
})

test("review hardening keeps routing, clipboard, url, and write guards explicit", () => {
  const source = readMessagePartSources()

  expect(source).toContain("return path.slice(prefix.length)")
  expect(source).toContain("path.search(/\\/session(?:\\/|$)/)")
  expect([...source.matchAll(/try \{\n\s+await navigator\.clipboard\.writeText/g)].length).toBe(2)
  expect(source).toContain('if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return ""')
  expect(source).toContain("getDiagnostics(props.metadata?.diagnostics, props.input.filePath)")
  expect(source).toContain("props.input.content != null && path()")
})
