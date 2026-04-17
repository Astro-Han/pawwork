import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "desktop-smoke.yml")

function readWorkflow() {
  expect(fs.existsSync(workflowPath)).toBe(true)
  return fs.readFileSync(workflowPath, "utf8")
}

describe("desktop smoke workflow", () => {
  test("defines a PR-safe macOS arm64 smoke build", () => {
    const workflow = readWorkflow()

    expect(workflow).toContain("name: desktop-smoke")
    expect(workflow).toContain("pull_request:")
    expect(workflow).toContain("push:")
    expect(workflow).toContain("workflow_dispatch:")
    expect(workflow).toContain("branches: [dev]")
    expect(workflow).toContain("permissions:")
    expect(workflow).toContain("contents: read")
    expect(workflow).toContain("runs-on: macos-14")

    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"')
    expect(workflow).toContain("OPENCODE_CHANNEL: dev")
    expect(workflow).toContain("bun install --frozen-lockfile")
    expect(workflow).toContain("bun run build")
    expect(workflow).toContain(
      "npx electron-builder --mac dir --arm64 --publish never --config electron-builder.config.ts",
    )
    expect(workflow).toContain("--config.mac.identity=-")
    expect(workflow).toContain("--config.mac.notarize=false")

    expect(workflow).toContain("Expected app bundle at")
    expect(workflow).toContain("Expected executable at")
    expect(workflow).toContain("Expected Info.plist at")
    expect(workflow).toContain("Expected app.asar at")
    expect(workflow).toContain("Expected Electron Framework at")
    expect(workflow).toContain("Expected helper app at")
    expect(workflow).toContain("codesign -dv --verbose=2")
    expect(workflow).toContain('grep -q "Signature=adhoc"')
    expect(workflow).not.toContain("codesign --verify --deep --verbose=2")
    expect(workflow).not.toContain("codesign --verify --deep --strict --verbose=2")
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("secrets.")
  })
})
