import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "desktop-smoke.yml")

function readWorkflow() {
  expect(fs.existsSync(workflowPath)).toBe(true)
  return fs.readFileSync(workflowPath, "utf8")
}

type WorkflowStep = {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

type WorkflowJob = {
  if?: string
  needs?: string | string[]
  "runs-on"?: string
  outputs?: Record<string, string>
  steps?: WorkflowStep[]
}

type Workflow = {
  name?: string
  on?: Record<string, unknown>
  permissions?: Record<string, string>
  jobs?: Record<string, WorkflowJob>
}

function parseWorkflow() {
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

describe("desktop smoke workflow", () => {
  test("defines a PR-safe macOS arm64 smoke build", () => {
    const workflow = readWorkflow()
    const parsed = parseWorkflow()
    const jobs = parsed.jobs ?? {}
    const changes = jobs.changes
    const smoke = jobs["smoke-macos-arm64"]
    const check = jobs.check
    const smokeSteps = smoke?.steps ?? []
    const packageStep = smokeSteps.find((step) => step.name === "Package desktop app")
    const smokeStep = smokeSteps.find((step) => step.name === "Smoke check app bundle")

    expect(parsed.name).toBe("desktop-smoke")
    expect(parsed.on?.push).toEqual({ branches: ["dev"] })
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.workflow_dispatch).toEqual(null)
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(Object.keys(jobs).sort()).toEqual(["changes", "check", "smoke-macos-arm64"])

    expect(changes?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(smoke?.needs).toBe("changes")
    expect(smoke?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(smoke?.["runs-on"]).toBe("macos-14")
    expect(check?.if).toBe("always()")
    expect(check?.needs).toEqual(["changes", "smoke-macos-arm64"])

    expect(workflow).not.toContain("strategy:")
    expect(workflow).not.toContain("matrix:")

    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("bun run build")
    expect(packageStep?.run).toContain(
      "npx electron-builder --mac dir --arm64 --publish never --config electron-builder.config.ts",
    )
    expect(packageStep?.run).toContain("--config.mac.identity=-")
    expect(packageStep?.run).toContain("--config.mac.notarize=false")
    expect(packageStep?.env).toEqual({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      OPENCODE_CHANNEL: "dev",
    })

    expect(smokeStep?.run).toContain("Expected app bundle at")
    expect(smokeStep?.run).toContain("Expected executable at")
    expect(smokeStep?.run).toContain("Expected Info.plist at")
    expect(smokeStep?.run).toContain("Expected app.asar at")
    expect(smokeStep?.run).toContain("Expected Electron Framework at")
    expect(smokeStep?.run).toContain("Expected helper app at")
    expect(smokeStep?.run).toContain("codesign -dv --verbose=2")
    expect(smokeStep?.run).toContain('grep -q "Signature=adhoc"')

    expect(workflow).toContain("smoke-macos-arm64.result")
    expect(workflow).toContain("Docs-only change, desktop smoke skipped.")
    expect(workflow).not.toContain("codesign --verify --deep --verbose=2")
    expect(workflow).not.toContain("codesign --verify --deep --strict --verbose=2")
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("secrets.")
  })
})
