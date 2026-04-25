import { describe, expect } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { parseWorkflow, readWorkflow } from "./workflow-parser"

const repoRoot = path.join(import.meta.dir, "../../../..")
const workflowPath = path.join(repoRoot, ".github", "workflows", "build.yml")

describe("release workflow", () => {
  it.live("selects the macOS x64 release matrix", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runSelectBuildTarget({ target: "macos", arch: "x64", phase: "submit" }),
      )

      expect(result.status).toBe(0)
      expect(result.outputs.target).toBe("macos")
      expect(result.outputs.arch).toBe("x64")
      expect(JSON.parse(result.outputs.matrix ?? "")).toEqual({
        include: [{ host: "macos-15-intel", target: "macos", platform_flag: "--mac --x64", arch_label: "x64" }],
      })
    }),
  )

  it.live("selects the Windows x64 release matrix", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runSelectBuildTarget({ target: "windows", arch: "x64", phase: "submit" }),
      )

      expect(result.status).toBe(0)
      expect(result.outputs.target).toBe("windows")
      expect(result.outputs.arch).toBe("x64")
      expect(JSON.parse(result.outputs.matrix ?? "")).toEqual({
        include: [{ host: "windows-latest", target: "windows", platform_flag: "--win", arch_label: "x64" }],
      })
    }),
  )

  it.live("rejects unsupported Windows release combinations", () =>
    Effect.gen(function* () {
      const arm64 = yield* Effect.promise(() =>
        runSelectBuildTarget({ target: "windows", arch: "arm64", phase: "submit" }),
      )
      const finalize = yield* Effect.promise(() =>
        runSelectBuildTarget({ target: "windows", arch: "x64", phase: "finalize" }),
      )

      expect(arm64.status).toBe(1)
      expect(arm64.output).toContain("Unsupported Windows arch: arm64")
      expect(finalize.status).toBe(1)
      expect(finalize.output).toContain("Windows releases do not use the macOS notarization finalize phase")
    }),
  )

  it.live("ignores malformed GitHub output lines", () =>
    Effect.gen(function* () {
      expect(parseGithubOutput("target=windows\nnot-an-output-line\narch=x64\n")).toEqual({
        target: "windows",
        arch: "x64",
      })
    }),
  )

  it.live("writes the submit phase summary without executing Markdown backticks", () =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() => runSummarizeSubmitPhase())

      expect(result.status).toBe(0)
      expect(result.output).not.toContain("command not found")
      expect(result.summary).toContain("- Submission ID: `sample-submission-id`")
      expect(result.summary).toContain("- Source run ID: `123456`")
      expect(result.summary).toContain("- Source sha: `0123456789abcdef0123456789abcdef01234567`")
      expect(result.summary).toContain(
        "`gh workflow run build.yml --repo Astro-Han/pawwork --ref workflow-snapshot-123",
      )
      expect(result.summary).not.toContain("\\`gh workflow run")
    }),
  )

  it.live("validates the release workflow configuration", () =>
    Effect.gen(function* () {
      const workflow = readWorkflow(workflowPath)
      const parsed = parseWorkflow(workflowPath)
      const selectBuildTarget = parsed.jobs?.["select-build-target"]
      const createSnapshotTag = parsed.jobs?.["create-snapshot-tag"]
      const buildElectron = parsed.jobs?.["build-electron"]
      const cleanupSnapshotTag = parsed.jobs?.["cleanup-snapshot-tag"]
      const steps = buildElectron?.steps ?? []
      const checkoutSteps = steps.filter(
        (step) => step.uses === "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
      )
      const setupNodeStep = steps.find(
        (step) => step.uses === "actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f",
      )
      const signedArtifactStep = steps.find((step) => step.name === "Upload signed app artifact")
      const nonMacArtifactStep = steps.find((step) => step.name === "Upload packaged app artifact")
      const buildElectronAppStep = steps.find((step) => step.name === "Build Electron app")
      const runtimeImportGuardStep = steps.find((step) => step.name === "Check desktop runtime imports")
      const setupAppleApiKeyStep = steps.find((step) => step.name === "Setup Apple API Key")
      const packageAppStep = steps.find((step) => step.name === "Package app")
      const packageVersionStep = steps.find((step) => step.id === "package_version")
      const downloadExistingMetadataStep = steps.find((step) => step.name === "Download existing updater metadata")
      const collectLatestYmlStep = steps.find((step) => step.name === "Collect updater metadata")
      const finalizeLatestYmlStep = steps.find((step) => step.name === "Finalize updater metadata")
      const packageNotarizedStep = steps.find((step) => step.name === "Package notarized artifacts")
      const validateSelectedTargetStep = steps.find((step) => step.name === "Validate selected target")
      const smokeSignedAppStep = steps.find((step) => step.name === "Smoke signed macOS app")
      const packageSignedAppStep = steps.find((step) => step.name === "Package signed app")

      expect(parsed.name).toBe("release")
      expect(parsed.permissions).toEqual({
        actions: "read",
        contents: "write",
      })
      expect(parsed.concurrency?.group).toBe(
        "${{ github.workflow }}-${{ inputs.source_ref || github.ref_name }}-${{ inputs.phase || 'submit' }}-${{ inputs.channel || 'dev' }}-${{ inputs.target || 'macos' }}",
      )
      expect(parsed.concurrency?.["cancel-in-progress"]).toBe(false)
      expect(parsed.on?.workflow_dispatch).toBeDefined()
      expect(workflow).toContain("target:")
      expect(workflow).toContain("- macos")
      expect(workflow).toContain("- windows")
      expect(workflow).toContain("- x64")
      expect(selectBuildTarget?.["runs-on"]).toBe("ubuntu-latest")
      expect(selectBuildTarget?.outputs).toEqual({
        arch: "${{ steps.select.outputs.arch }}",
        matrix: "${{ steps.select.outputs.matrix }}",
        target: "${{ steps.select.outputs.target }}",
      })
      expect(createSnapshotTag?.needs).toContain("select-build-target")
      expect(buildElectron?.["runs-on"]).toBe("${{ matrix.host }}")
      expect(buildElectron?.needs).toEqual(["select-build-target", "create-snapshot-tag"])
      expect(buildElectron?.if).toContain("needs.select-build-target.result == 'success'")
      expect(cleanupSnapshotTag?.needs).toContain("build-electron")
      expect(cleanupSnapshotTag?.if).toBe(
        "${{ always() && inputs.phase == 'finalize' && needs.build-electron.result == 'success' }}",
      )
      expect(checkoutSteps).toHaveLength(2)
      expect(checkoutSteps[0]?.with).toEqual({ "persist-credentials": false })
      expect(checkoutSteps[1]?.with).toEqual({
        "persist-credentials": false,
        ref: "${{ inputs.source_sha }}",
      })
      expect(setupNodeStep?.with).toEqual({ "node-version": "24" })
      expect(signedArtifactStep?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
      expect(nonMacArtifactStep?.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
      expect(nonMacArtifactStep?.if).toBe("${{ runner.os == 'Windows' && inputs.phase != 'finalize' }}")
      expect(nonMacArtifactStep?.with?.["if-no-files-found"]).toBe("error")
      expect(nonMacArtifactStep?.with?.path).toContain("packages/desktop-electron/dist/*.exe")
      expect(nonMacArtifactStep?.with?.path).toContain("packages/desktop-electron/dist/latest*.yml")
      expect(validateSelectedTargetStep?.shell).toBe("bash")
      expect(validateSelectedTargetStep?.env).toEqual({
        SELECTED_TARGET: "${{ needs.select-build-target.outputs.target }}",
        SELECTED_ARCH: "${{ needs.select-build-target.outputs.arch }}",
      })
      expect(buildElectronAppStep?.env).toEqual({
        OPENCODE_CHANNEL: "${{ inputs.channel || 'dev' }}",
        PAWWORK_FEEDBACK_FORM_URL: "${{ vars.PAWWORK_FEEDBACK_FORM_URL || '' }}",
        PAWWORK_BUILD_SHA: "${{ github.sha }}",
      })
      expect(runtimeImportGuardStep?.if).toBe("${{ inputs.phase != 'finalize' }}")
      expect(runtimeImportGuardStep?.run).toBe("bun ./scripts/runtime-import-guard.ts")
      expect(runtimeImportGuardStep?.["working-directory"]).toBe("packages/desktop-electron")
      expect(steps.indexOf(runtimeImportGuardStep!)).toBeGreaterThan(steps.indexOf(buildElectronAppStep!))
      expect(steps.indexOf(runtimeImportGuardStep!)).toBeLessThan(steps.indexOf(setupAppleApiKeyStep!))
      expect(packageAppStep?.shell).toBe("bash")
      expect(packageAppStep?.env).toEqual({
        OPENCODE_CHANNEL: "${{ inputs.channel || 'dev' }}",
        PAWWORK_FEEDBACK_FORM_URL: "${{ vars.PAWWORK_FEEDBACK_FORM_URL || '' }}",
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      })
      expect(packageAppStep?.run).toContain('publish_flag="never"')
      expect(packageAppStep?.run).toContain('if [ "${{ inputs.phase || \'submit\' }}" = "full" ]; then')
      expect(packageAppStep?.run).toContain('publish_flag="always"')
      expect(smokeSignedAppStep?.if).toBe(
        "${{ runner.os == 'macOS' && (inputs.phase == 'submit' || inputs.phase == 'full') }}",
      )
      expect(smokeSignedAppStep?.["working-directory"]).toBe("packages/desktop-electron")
      expect(smokeSignedAppStep?.env).toEqual({
        OPENCODE_CHANNEL: "${{ inputs.channel || 'dev' }}",
      })
      expect(smokeSignedAppStep?.run).toContain('case "$OPENCODE_CHANNEL" in')
      expect(smokeSignedAppStep?.run).toContain('EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$APP_NAME"')
      expect(smokeSignedAppStep?.run).toContain(
        'bun ./scripts/ci-smoke.ts packaged "$OPENCODE_CHANNEL" "$EXECUTABLE_PATH"',
      )
      expect(packageSignedAppStep).toBeDefined()
      expect(steps.indexOf(smokeSignedAppStep!)).toBeGreaterThan(steps.indexOf(packageSignedAppStep!))
      expect(steps.indexOf(smokeSignedAppStep!)).toBeLessThan(steps.indexOf(signedArtifactStep!))
      expect(packageVersionStep?.run).toContain("version=$(node -p")
      expect(downloadExistingMetadataStep).toBeDefined()
      expect(downloadExistingMetadataStep?.run).toContain("gh release download")
      expect(downloadExistingMetadataStep?.run).toContain("latest-mac.yml")
      expect(downloadExistingMetadataStep?.run).toContain("latest.yml")
      expect(steps.indexOf(downloadExistingMetadataStep!)).toBeLessThan(steps.indexOf(packageNotarizedStep!))
      expect(steps.indexOf(downloadExistingMetadataStep!)).toBeLessThan(steps.indexOf(packageAppStep!))
      expect(packageNotarizedStep?.env).toEqual({
        OPENCODE_CHANNEL: "${{ inputs.channel || 'dev' }}",
        PAWWORK_FEEDBACK_FORM_URL: "${{ vars.PAWWORK_FEEDBACK_FORM_URL || '' }}",
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      })
      expect(collectLatestYmlStep?.run).toContain("latest-yml-x86_64-apple-darwin")
      expect(collectLatestYmlStep?.run).toContain("latest-yml-aarch64-apple-darwin")
      expect(collectLatestYmlStep?.run).toContain("latest-yml-x86_64-pc-windows-msvc")
      expect(finalizeLatestYmlStep).toBeDefined()
      expect(finalizeLatestYmlStep!.run).toContain("bun ./scripts/finalize-latest-yml.ts")
      expect(finalizeLatestYmlStep?.env).toEqual({
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        GH_REPO: "${{ github.repository }}",
        EXISTING_LATEST_YML_DIR: "${{ runner.temp }}/existing-latest-yml",
        LATEST_YML_DIR: "${{ runner.temp }}/latest-yml",
        OPENCODE_VERSION: "${{ steps.package_version.outputs.version }}",
      })

      expect(workflow).not.toContain("persist-credentials: true")
      expect(workflow).not.toContain("pull_request_target")
    }),
  )
})

/** Runs the workflow selector step and returns the status plus GITHUB_OUTPUT entries. */
async function runSelectBuildTarget(input: { target: string; arch: string; phase: string }) {
  const ruby = String.raw`
    require "yaml"

    data = YAML.load_file(ARGV[0])
    step = data["jobs"]["select-build-target"]["steps"].find { |entry| entry["id"] == "select" }
    raise "Missing select-build-target step with id=select" unless step
    puts step["run"]
  `
  const script = execFileSync("ruby", ["-e", ruby, workflowPath], { encoding: "utf8" })
  await using tmp = await tmpdir()
  const outputPath = path.join(tmp.path, "github-output")
  const result = spawnSync("bash", ["-ec", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_TARGET: input.target,
      INPUT_ARCH: input.arch,
      INPUT_PHASE: input.phase,
      GITHUB_OUTPUT: outputPath,
    },
  })

  const outputs = fs.existsSync(outputPath) ? parseGithubOutput(fs.readFileSync(outputPath, "utf8")) : {}

  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    outputs,
  }
}

/** Runs the submit summary step with sample GitHub expression values. */
async function runSummarizeSubmitPhase() {
  const parsed = parseWorkflow(workflowPath)
  const step = parsed.jobs?.["build-electron"]?.steps?.find((entry) => entry.name === "Summarize submit phase")
  if (!step?.run) {
    throw new Error("Missing Summarize submit phase step")
  }

  const script = replaceGithubExpressions(step.run)
  await using tmp = await tmpdir()
  const summaryPath = path.join(tmp.path, "step-summary")
  const result = spawnSync("bash", ["-ec", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
  })

  return {
    status: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
    summary: fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, "utf8") : "",
  }
}

function replaceGithubExpressions(script: string) {
  const replacements: Record<string, string> = {
    "steps.submit_notarization.outputs.submission_id": "sample-submission-id",
    "github.run_id": "123456",
    "github.run_attempt": "2",
    "github.ref_name": "dev",
    "github.sha": "0123456789abcdef0123456789abcdef01234567",
    "matrix.arch_label": "arm64",
    "needs.create-snapshot-tag.outputs.workflow_ref": "workflow-snapshot-123",
    "needs.create-snapshot-tag.outputs.workflow_sha": "abcdef0123456789abcdef0123456789abcdef01",
    "inputs.channel || 'dev'": "prod",
    "github.repository": "Astro-Han/pawwork",
  }

  const result = script.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (match, expression) => {
    const key = expression.trim()
    return replacements[key] ?? match
  })

  if (result.includes("${{")) {
    throw new Error(`Unreplaced GitHub expression in submit summary script:\n${result}`)
  }
  return result
}

/** Parses the simple key=value records emitted to GITHUB_OUTPUT by this workflow step. */
function parseGithubOutput(output: string) {
  return Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const index = line.indexOf("=")
        return index === -1 ? [] : ([[line.slice(0, index), line.slice(index + 1)]] as const)
      }),
  )
}
