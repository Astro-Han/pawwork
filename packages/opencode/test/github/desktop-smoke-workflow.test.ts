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
    const docsPathsStep = changesSteps.find((step) => step.id === "docs-paths")
    const codePathsStep = changesSteps.find((step) => step.id === "code-paths")
    const filterStep = changesSteps.find((step) => step.id === "filter")
    const smokeCheckoutStep = smokeSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    const smokeBunStep = smokeSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    const appSmokeStep = smokeSteps.find((step) => step.name === "Launch desktop smoke app")
    const packageStep = smokeSteps.find((step) => step.name === "Package desktop app")
    const smokeStep = smokeSteps.find((step) => step.name === "Smoke check app bundle")
    const runtimeGuardStep = smokeSteps.find((step) => step.name === "Check desktop runtime imports")
    const packagedSmokeStep = smokeSteps.find((step) => step.name === "Launch packaged desktop smoke app")
    const buildStep = smokeSteps.find((step) => step.name === "Build desktop app")
    const reportSmokeStep = smokeSteps.find((step) => step.name === "Report problem smoke")
    const prepareOfficeCliStep = smokeSteps.find((step) => step.name === "Prepare OfficeCLI")
    const installStep = smokeSteps.find((step) => step.name === "Install dependencies")
    const repairElectronStep = smokeSteps.find((step) => step.name === "Repair Electron install")
    const repairElectronAfterBuildStep = smokeSteps.find((step) => step.name === "Repair Electron install after build")

    expect(parsed.name).toBe("desktop-smoke")
    expect(parsed.on?.push).toEqual({ branches: ["dev"] })
    expect(parsed.on?.pull_request).toEqual({ branches: ["dev"] })
    expect(parsed.on?.workflow_dispatch).toEqual(null)
    expect(parsed.concurrency?.group).toContain("desktop-smoke-")
    expect(parsed.concurrency?.group).toContain("github.ref == 'refs/heads/dev'")
    expect(parsed.concurrency?.group).toContain("github.run_id")
    expect(parsed.concurrency?.group).toContain("github.event.pull_request.number || github.ref")
    expect(parsed.concurrency?.["cancel-in-progress"]).toBe("${{ github.ref != 'refs/heads/dev' }}")
    expect(parsed.permissions).toEqual({ contents: "read", "pull-requests": "read" })
    expect(Object.keys(jobs).sort()).toEqual(["changes", "check", "install-matrix", "smoke-macos-arm64"])
    expect(changesCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")
    expect(smokeCheckoutStep?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd")

    expect(changes?.outputs).toEqual({ docs_only: "${{ steps.filter.outputs.docs_only }}" })
    expect(docsPathsStep?.uses).toBe("dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d")
    expect(docsPathsStep?.with?.filters).toContain("docs:")
    expect(docsPathsStep?.with?.filters).toContain("'docs/**'")
    expect(codePathsStep?.uses).toBe("dorny/paths-filter@fbd0ab8f3e69293af611ebaee6363fc25e6d187d")
    expect(codePathsStep?.with?.["predicate-quantifier"]).toBe("every")
    expect(codePathsStep?.with?.filters).toContain("'!docs/**'")
    expect(codePathsStep?.with?.filters).not.toContain("*.md")
    expect(filterStep?.if).toBe("always()")
    expect(filterStep?.env?.DOCS_CHANGED).toBe("${{ steps.docs-paths.outputs.docs }}")
    expect(filterStep?.env?.CODE_CHANGED).toBe("${{ steps.code-paths.outputs.code }}")
    expect(changesCheckoutStep?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    })
    expect(changesCheckoutStep?.if).toBe("github.event_name == 'push'")
    expect(smoke?.needs).toBe("changes")
    expect(smoke?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(smoke?.["runs-on"]).toBe("macos-14")
    expect(check?.if).toBe("always()")
    expect(check?.needs).toEqual(["changes", "smoke-macos-arm64", "install-matrix"])

    // install-matrix job: validates Electron install on Node 24 and 26
    const install = jobs["install-matrix"]
    const installSteps = install?.steps ?? []
    expect(install?.needs).toBe("changes")
    expect(install?.if).toBe("needs.changes.outputs.docs_only != 'true'")
    expect(install?.["runs-on"]).toBe("macos-14")
    expect(install?.["timeout-minutes"]).toBe(10)
    expect(install?.strategy?.matrix?.["node-version"]).toEqual(["24", "26"])
    const installCheckout = installSteps.find((step) => step.uses?.startsWith("actions/checkout@"))
    expect(installCheckout?.with?.["persist-credentials"]).toBe(false)
    const installSetupNode = installSteps.find((step) => step.uses?.startsWith("actions/setup-node@"))
    expect(installSetupNode?.with?.["node-version"]).toBe("${{ matrix.node-version }}")
    const installBunStep = installSteps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))
    expect(installBunStep?.with?.["bun-version"]).toBe("1.3.14")
    const installDepsStep = installSteps.find((step) => step.name === "Install dependencies")
    expect(installDepsStep?.run).toBe("bun install --frozen-lockfile")
    const assertStep = installSteps.find((step) => step.name === "Assert Electron install complete")
    expect(assertStep?.run).toBe("node ./scripts/repair-electron-install.mjs --assert-complete")
    expect(assertStep?.["working-directory"]).toBe("packages/desktop-electron")

    // smoke-macos-arm64 must not use strategy/matrix (install-matrix is the only job that does)
    expect(workflow).toContain("strategy:")
    expect(workflow).toContain("matrix:")
    const smokeRaw = workflow.slice(workflow.indexOf("smoke-macos-arm64:"), workflow.indexOf("install-matrix:"))
    expect(smokeRaw).not.toContain("strategy:")
    expect(smokeRaw).not.toContain("matrix:")

    expect(smokeCheckoutStep?.with).toEqual({ "persist-credentials": false })
    expect(smokeBunStep?.uses).toBe("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6")
    expect(installStep?.run).toBe("bun install --frozen-lockfile")
    expect(repairElectronStep?.run).toBe("node ./scripts/repair-electron-install.mjs")
    expect(repairElectronStep?.["working-directory"]).toBe("packages/desktop-electron")
    expect(repairElectronAfterBuildStep).toBeDefined()
    expect(repairElectronAfterBuildStep?.run).toBe("node ./scripts/repair-electron-install.mjs")
    expect(repairElectronAfterBuildStep?.["working-directory"]).toBe("packages/desktop-electron")
    expect(prepareOfficeCliStep).toBeDefined()
    expect(prepareOfficeCliStep?.run).toBe("bun ./scripts/prepare-officecli.ts --platform darwin --arch arm64")
    expect(prepareOfficeCliStep?.["working-directory"]).toBe("packages/desktop-electron")
    expect(workflow).toContain("bun run build")
    expect(appSmokeStep?.run).toBe("bun run smoke:ci")
    expect(appSmokeStep?.env).toEqual({
      PAWWORK_CI_SMOKE_CDP: "true",
    })
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

    expect(runtimeGuardStep?.run).toBe("bun ./scripts/runtime-import-guard.ts")
    expect(runtimeGuardStep?.["working-directory"]).toBe("packages/desktop-electron")
    expect(packagedSmokeStep?.run).toContain(
      'EXECUTABLE_PATH="dist/mac-arm64/PawWork Dev.app/Contents/MacOS/PawWork Dev"',
    )
    expect(packagedSmokeStep?.run).toContain('bun ./scripts/ci-smoke.ts packaged dev "$EXECUTABLE_PATH"')
    expect(packagedSmokeStep?.env).toEqual({
      PAWWORK_CI_SMOKE_CDP: "true",
    })
    expect(packagedSmokeStep?.["working-directory"]).toBe("packages/desktop-electron")
    expect(reportSmokeStep?.env).not.toHaveProperty("PAWWORK_CI_SMOKE_CDP_PORT")
    expect(buildStep).toBeDefined()
    expect(smokeSteps.indexOf(repairElectronStep!)).toBeGreaterThan(smokeSteps.indexOf(installStep!))
    expect(smokeSteps.indexOf(repairElectronStep!)).toBeLessThan(smokeSteps.indexOf(prepareOfficeCliStep!))
    expect(smokeSteps.indexOf(prepareOfficeCliStep!)).toBeGreaterThan(smokeSteps.indexOf(smokeBunStep!))
    expect(smokeSteps.indexOf(prepareOfficeCliStep!)).toBeLessThan(smokeSteps.indexOf(buildStep!))
    expect(smokeSteps.indexOf(repairElectronAfterBuildStep!)).toBeGreaterThan(smokeSteps.indexOf(buildStep!))
    expect(smokeSteps.indexOf(repairElectronAfterBuildStep!)).toBeLessThan(smokeSteps.indexOf(appSmokeStep!))
    expect(smokeSteps.indexOf(runtimeGuardStep!)).toBeGreaterThan(smokeSteps.indexOf(buildStep!))
    expect(smokeSteps.indexOf(runtimeGuardStep!)).toBeLessThan(smokeSteps.indexOf(appSmokeStep!))
    expect(smokeSteps.indexOf(packagedSmokeStep!)).toBeGreaterThan(smokeSteps.indexOf(smokeStep!))

    expect(smokeStep?.run).toContain("Expected app bundle at")
    expect(smokeStep?.run).toContain("Expected executable at")
    expect(smokeStep?.run).toContain("Expected Info.plist at")
    expect(smokeStep?.run).toContain("Expected app.asar at")
    expect(smokeStep?.run).toContain("Expected Electron Framework at")
    expect(smokeStep?.run).toContain("Expected helper app at")
    expect(smokeStep?.run).toContain("Expected executable OfficeCLI at")
    expect(smokeStep?.run).toContain('OFFICECLI_SKIP_UPDATE=1 "$OFFICECLI_PATH" --version')
    expect(smokeStep?.run).toContain("THIRD_PARTY_NOTICES.md")
    expect(smokeStep?.run).toContain("Expected third-party notices at")
    expect(smokeStep?.run).toContain("codesign -dv --verbose=2")
    expect(smokeStep?.run).toContain('grep -q "Signature=adhoc"')

    expect(workflow).toContain("smoke-macos-arm64.result")
    expect(workflow).toContain("Docs-only change, desktop smoke skipped.")
    expect(workflow).not.toContain("desktop-smoke-cdp-port")
    expect(workflow).not.toContain("packaged-smoke-cdp-port")
    expect(workflow).not.toContain("appendFileSync(process.env.GITHUB_OUTPUT")
    expect(workflow).not.toContain("GITHUB_ENV")
    expect(workflow).not.toContain("codesign --verify --deep --verbose=2")
    expect(workflow).not.toContain("codesign --verify --deep --strict --verbose=2")
    expect(workflow).not.toContain("pull_request_target")
    expect(workflow).not.toContain("secrets.")
  })
})
