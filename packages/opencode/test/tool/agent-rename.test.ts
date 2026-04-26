import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const REPO_ROOT = path.resolve(__dirname, "../../../..")

const WALK_PATHS = [
  "packages/opencode/src",
  "packages/opencode/test",
  "packages/ui/src",
  "packages/ui/test",
  "packages/app/src",
  "packages/app/test",
  "packages/app/e2e",
]

const SELF_PATH = "packages/opencode/test/tool/agent-rename.test.ts"

const LEGACY_RENDER_MARKER = /\bagent-rename:legacy-render\b/

const CASE_SENSITIVE_PATTERNS_WALK_WIDE: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "TaskTool", pattern: /\bTaskTool\b/ },
  { name: "TaskPromptOps", pattern: /\bTaskPromptOps\b/ },
  { name: "TaskDef", pattern: /\bTaskDef\b/ },
  { name: "task_id", pattern: /\btask_id\b/ },
  { name: 'Permission.evaluate("task")', pattern: /Permission\.evaluate\(\s*["']task["']/ },
  { name: 'evaluate("task")', pattern: /\bevaluate\(\s*["']task["']/ },
  { name: "tool.task", pattern: /\btool\.task\b/ },
  { name: "s.task", pattern: /\bs\.task\b/ },
  { name: "{ task: false }", pattern: /\{\s*task:\s*false\s*\}/ },
  { name: "Tool.init(task)", pattern: /Tool\.init\(task\)/ },
  { name: "<task_result>", pattern: /<\/?task_result>/ },
  { name: 'tool: "task"', pattern: /\btool:\s*["']task["']/ },
  { name: 'name: "task"', pattern: /\bname:\s*["']task["']/ },
  { name: '.tool === "task"', pattern: /\.tool\s*===\s*["']task["']/ },
  { name: '.tool !== "task"', pattern: /\.tool\s*!==\s*["']task["']/ },
]

const CASE_SENSITIVE_AGENT_TS_ONLY: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "canTask", pattern: /\bcanTask\b/ },
  { name: "taskID", pattern: /\btaskID\b/ },
]

const CASE_INSENSITIVE_PROSE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "Task tool (prose, word-boundary)", pattern: /\bTask tool\b/i },
  { name: "Task(description=", pattern: /Task\(description=/i },
]

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      yield* walkFiles(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf-8").split("\n")
}

describe("agent rename literal sweep (#128)", () => {
  test("AgentTool.id is 'agent'", async () => {
    const mod = await import("@/tool/agent")
    expect(mod.AgentTool.id).toBe("agent")
  })

  test("Zod schema has subagent_session_id and not task_id", async () => {
    const { parameters } = await import("@/tool/agent")
    expect(parameters.shape.subagent_session_id).toBeDefined()
    expect((parameters.shape as Record<string, unknown>).task_id).toBeUndefined()
  })

  test("agent.ts exists; task.ts does not", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "packages/opencode/src/tool/agent.ts"))).toBe(true)
    expect(fs.existsSync(path.join(REPO_ROOT, "packages/opencode/src/tool/task.ts"))).toBe(false)
  })

  for (const { name, pattern } of CASE_SENSITIVE_PATTERNS_WALK_WIDE) {
    test(`no occurrence of ${name} in source tree (excluding legacy-render lines)`, () => {
      const offenders: string[] = []
      for (const walkPath of WALK_PATHS) {
        const absWalk = path.join(REPO_ROOT, walkPath)
        if (!fs.existsSync(absWalk)) continue
        for (const file of walkFiles(absWalk)) {
          const rel = path.relative(REPO_ROOT, file)
          if (rel === SELF_PATH) continue
          if (!/\.(ts|tsx|txt|md)$/.test(file)) continue
          const lines = readLines(file)
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (LEGACY_RENDER_MARKER.test(line)) continue
            if (pattern.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
            }
          }
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([])
    })
  }

  for (const { name, pattern } of CASE_SENSITIVE_AGENT_TS_ONLY) {
    test(`no occurrence of ${name} in agent.ts`, () => {
      const file = path.join(REPO_ROOT, "packages/opencode/src/tool/agent.ts")
      const lines = readLines(file)
      const offenders: string[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (pattern.test(line)) offenders.push(`agent.ts:${i + 1}: ${line.trim()}`)
      }
      expect(offenders, offenders.join("\n")).toEqual([])
    })
  }

  for (const { name, pattern } of CASE_INSENSITIVE_PROSE_PATTERNS) {
    test(`no occurrence of ${name} in prose (case-insensitive, excluding legacy-render lines)`, () => {
      const offenders: string[] = []
      for (const walkPath of WALK_PATHS) {
        const absWalk = path.join(REPO_ROOT, walkPath)
        if (!fs.existsSync(absWalk)) continue
        for (const file of walkFiles(absWalk)) {
          const rel = path.relative(REPO_ROOT, file)
          if (rel === SELF_PATH) continue
          if (!/\.(ts|tsx|txt|md)$/.test(file)) continue
          const lines = readLines(file)
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]
            if (LEGACY_RENDER_MARKER.test(line)) continue
            if (pattern.test(line)) {
              offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
            }
          }
        }
      }
      expect(offenders, offenders.join("\n")).toEqual([])
    })
  }
})
