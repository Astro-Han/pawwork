import { execFileSync } from "node:child_process"
import fs from "node:fs"

/** Parsed subset of a workflow step used by workflow contract tests. */
export type WorkflowStep = {
  "continue-on-error"?: boolean
  id?: string
  if?: string
  name?: string
  run?: string
  shell?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

/** Parsed subset of a workflow job used by workflow contract tests. */
export type WorkflowJob = {
  "continue-on-error"?: boolean
  /** Minimal `defaults.run` subset; add fields only when contract tests assert them. */
  defaults?: {
    run?: {
      shell?: string
    }
  }
  if?: string
  name?: string
  needs?: string | string[]
  "runs-on"?: string
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
  strategy?: {
    "fail-fast"?: boolean
    matrix?: {
      include?: Record<string, unknown>[]
    }
  }
  "timeout-minutes"?: number
}

/** Parsed subset of a GitHub Actions workflow used by workflow contract tests. */
export type Workflow = {
  name?: string
  concurrency?: {
    group?: string
    "cancel-in-progress"?: boolean
  }
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

/** Reads a workflow file as UTF-8 and fails clearly when it is missing. */
export function readWorkflow(workflowPath: string) {
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Missing workflow: ${workflowPath}`)
  }
  return fs.readFileSync(workflowPath, "utf8")
}

/** Parses workflow YAML with Ruby, preserving GitHub's `on` key for assertions. */
export function parseWorkflow(workflowPath: string) {
  const parsed = execFileSync(
    "ruby",
    [
      "-e",
      `
        require "json"
        require "yaml"

        data = YAML.load_file(ARGV[0])
        data["on"] = data.delete(true) if data.key?(true)
        puts JSON.generate(data)
      `,
      workflowPath,
    ],
    { encoding: "utf8" },
  )

  return JSON.parse(parsed) as Workflow
}
