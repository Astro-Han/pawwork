import { execFileSync } from "node:child_process"
import fs from "node:fs"

export type WorkflowStep = {
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

export type WorkflowJob = {
  "continue-on-error"?: boolean
  if?: string
  needs?: string | string[]
  "runs-on"?: string
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  steps?: WorkflowStep[]
  "timeout-minutes"?: number
}

export type Workflow = {
  name?: string
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

export function readWorkflow(workflowPath: string) {
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Missing workflow: ${workflowPath}`)
  }
  return fs.readFileSync(workflowPath, "utf8")
}

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
