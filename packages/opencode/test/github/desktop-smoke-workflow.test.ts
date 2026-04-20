import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "desktop-smoke.yml")

describe("desktop smoke workflow", () => {
  test("defines a PR-safe macOS arm64 smoke build", () => {
    const workflow = readWorkflow(workflowPath)
    const parsed = parseWorkflow(workflowPath)
    const jobs = parsed.jobs ?? {}
    const changes = jobs.changes
    const smoke = jobs["smoke-macos-arm64"]
    const check = jobs.check
    const changesSteps = changes?.steps ?? []
    const smokeSteps = smoke?.steps ?? []
    const changesCheckoutStep = changesSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const smokeCheckoutStep = smokeSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const smokeBunStep = smokeSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const appSmokeStep = smokeSteps.find((step) => step.name === "Launch desktop smoke app")
    const packageStep = smokeSteps.find((step) => step.name === "Package desktop app")
    const smokeStep = smokeSteps.find((step) => step.name === "Smoke check app bundle")

    expect(parsed.name).toBe("desktop-smoke")
    expect(parsed.on?.push).toEqual({ branches: ["dev"] })
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.workflow_dispatch).toEqual(null)
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(Object.keys(jobs).sort()).toEqual(["changes", "check", "smoke-macos-arm64"])
    expect(changesCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(smokeCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")

    expect(changes?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(changesCheckoutStep?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    })
    expect(smoke?.needs).toBe("changes")
    expect(smoke?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(smoke?.["runs-on"]).toBe("macos-14")
    expect(check?.if).toBe("always()")
    expect(check?.needs).toEqual(["changes", "smoke-macos-arm64"])

    expect(workflow).not.toContain("strategy:")
    expect(workflow).not.toContain("matrix:")

    expect(smokeCheckoutStep?.with).toEqual({ "persist-credentials": false })
    expect(smokeBunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("bun run build")
    expect(appSmokeStep?.run).toBe("bun run smoke:ci")
    expect(workflow).toContain("Launch desktop smoke app")
    expect(workflow).toContain("bun run smoke:ci")
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
