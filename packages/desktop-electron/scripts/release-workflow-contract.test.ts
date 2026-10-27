import { describe, expect, test } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A unit test cannot prove what a shell workflow does — only that a step whose
// absence would ship an unverified or incomplete build is still there, and still
// ordered correctly. These read the workflow as steps rather than as text, so a
// reformat inside a step does not fail them and a deleted step does.
const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")
const publisher = readFileSync(join(import.meta.dirname, "publish-when-complete.ts"), "utf8")

const steps = workflow
  .split(/\n {6}- name: /)
  .slice(1)
  .map((block) => ({ name: block.split("\n")[0].trim(), body: block }))

function stepsRunning(pattern: RegExp) {
  return steps.filter((step) => pattern.test(step.body))
}

function indexOfStep(name: string) {
  return steps.findIndex((step) => step.name === name)
}

function conditionOfStep(name: string) {
  const condition = steps[indexOfStep(name)]?.body.match(/\n {8}if: (?<condition>.+)/)?.groups?.condition
  if (!condition) throw new Error(`step "${name}" has no if: condition`)
  return condition
}

function runSourceValidation(phase: string, githubRef: string, sourceRef = "") {
  const match = workflow.match(
    /- name: Validate release source branch\n\s+run: \|\n(?<script>(?: {10}.*\n|\n)+?)\s+env:/,
  )
  if (!match?.groups?.script) throw new Error("release source validation step is missing")

  return spawnSync("bash", ["-c", match.groups.script.replace(/^ {10}/gm, "")], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SOURCE_REF: "main",
      GITHUB_REF: githubRef,
      PHASE: phase,
      SOURCE_REF: sourceRef,
    },
  })
}

// Runs the upload step's script against a dist/ of four installers, with fake
// `pnpm` and `gh` that record their calls; `pnpm` exits with `withdrawStatus`.
function runInstallerUpload(withdrawStatus: number) {
  const script = steps[indexOfStep("Upload notarized artifacts")]?.body.match(
    /\n {8}run: \|\n(?<script>(?: {10}.*\n|\n)+?) {8}working-directory:/,
  )?.groups?.script
  if (!script) throw new Error("installer upload step is missing")

  const dir = mkdtempSync(join(tmpdir(), "installer-upload-"))
  mkdirSync(join(dir, "dist"))
  mkdirSync(join(dir, "bin"))
  for (const file of ["a.dmg", "a.dmg.blockmap", "a.zip", "a.zip.blockmap"]) writeFileSync(join(dir, "dist", file), "")
  const log = join(dir, "calls.log")
  writeFileSync(join(dir, "bin", "pnpm"), `#!/bin/sh\necho "pnpm $*" >> "${log}"\nexit ${withdrawStatus}\n`, {
    mode: 0o755,
  })
  writeFileSync(join(dir, "bin", "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\n`, { mode: 0o755 })

  const result = spawnSync("bash", ["-c", script.replace(/^ {10}/gm, "")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      GH_REPO: "owner/repo",
      RELEASE_TAG: "v2026.1.1",
    },
  })
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, calls }
}

describe("release workflow", () => {
  test("accepts main branch submit and finalize sources", () => {
    expect(runSourceValidation("submit", "refs/heads/main").status).toBe(0)
    expect(runSourceValidation("finalize", "refs/tags/workflow-snapshot-1", "main").status).toBe(0)
  })

  test("rejects release sources outside main", () => {
    expect(runSourceValidation("submit", "refs/heads/dev").status).toBe(1)
    expect(runSourceValidation("finalize", "refs/tags/workflow-snapshot-1", "dev").status).toBe(1)
  })

  test("requires the workflow to name the mirror branch explicitly", () => {
    expect(publisher).toContain('const mirrorRef = requireEnv("MIRROR_REF")')
    expect(publisher).not.toMatch(/MIRROR_REF.*\?\?/)
  })

  // electron-builder creates the release when the tag has none and uploads a
  // target's assets concurrently, so without a claimed draft the first phase to
  // publish for a tag can split its assets across two of them.
  test("claims one release draft before any step uploads assets", () => {
    const ensure = indexOfStep("Ensure a single release draft")
    expect(ensure).toBeGreaterThanOrEqual(0)
    expect(steps[ensure].body).toMatch(/ensure-release-draft\.ts/)
    // Every target that uploads to the release has to claim the draft, and only
    // those: the same gate the metadata finalizer runs under, word for word.
    expect(conditionOfStep("Ensure a single release draft")).toBe(conditionOfStep("Finalize updater metadata"))

    const uploading = stepsRunning(/gh release upload/)
    expect(uploading.map((step) => step.name)).toEqual(["Upload notarized artifacts"])
    // Every mac run that finalizes the feed uploads the installers it describes.
    const macUpload = conditionOfStep("Upload notarized artifacts").match(
      /^\$\{\{ inputs\.channel != 'dev' && (?<mac>runner\.os == 'macOS' .+) \}\}$/,
    )?.groups?.mac
    expect(macUpload).toBeDefined()
    expect(conditionOfStep("Finalize updater metadata")).toContain(`(${macUpload})`)
    for (const step of uploading) expect(steps.indexOf(step)).toBeGreaterThan(ensure)
    // Windows resolves --publish through a variable, so it is ordered by name.
    expect(indexOfStep("Package app")).toBeGreaterThan(ensure)
  })

  // A single-arch copy uploaded by a job that then fails is read back by its
  // re-run as the existing feed, dropping the other arch.
  test("leaves the mac updater feed to the metadata finalizer alone", () => {
    const macPackaging = stepsRunning(/electron-builder .*--mac/)
    expect(macPackaging.length).toBeGreaterThan(0)
    for (const step of macPackaging) expect(step.body).toMatch(/--publish never/)
    const upload = steps[indexOfStep("Upload notarized artifacts")]
    expect(upload.body).not.toMatch(/latest/)
    // Nothing reaches the release before both copies of the bundle are verified.
    expect(indexOfStep("Upload notarized artifacts")).toBeGreaterThan(indexOfStep("Verify notarized artifacts"))
    expect(indexOfStep("Finalize updater metadata")).toBeGreaterThan(indexOfStep("Upload notarized artifacts"))
  })

  // The withdraw refuses a published release; replacing installers before it
  // succeeds could leave the old marker vouching for them.
  test("withdraws this target's marker before replacing its installers", () => {
    const withdraw = "pnpm exec tsx ./scripts/publish-when-complete.ts --withdraw-marker"
    const ok = runInstallerUpload(0)
    expect(ok.status).toBe(0)
    expect(ok.calls).toEqual([
      withdraw,
      "gh release upload v2026.1.1 dist/a.dmg dist/a.dmg.blockmap dist/a.zip dist/a.zip.blockmap --clobber --repo owner/repo",
    ])

    const refused = runInstallerUpload(1)
    expect(refused.status).toBe(1)
    expect(refused.calls).toEqual([withdraw])
  })

  test("staples and validates through the network retry", () => {
    expect(workflow).not.toMatch(/xcrun stapler/)
    expect(stepsRunning(/scripts\/stapler\.ts staple/).map((step) => step.name)).toEqual(["Finalize notarization"])
    expect(stepsRunning(/scripts\/stapler\.ts validate/).map((step) => step.name)).toEqual([
      "Finalize notarization",
      "Verify notarized artifacts",
    ])
  })

  test("release lookup refuses a split tag instead of reading half of one", () => {
    expect(publisher).toContain("duplicateReleasesMessage(tag, matches)")
  })

  test("bundles uv and Python before anything packages the app", () => {
    const packaging = stepsRunning(/electron-builder .*(--mac|\$\{\{ matrix\.platform_flag \}\})/)
    // submit packs the signed directory, finalize repacks it into dmg/zip, and
    // Windows packs in one go.
    expect(packaging.map((step) => step.name)).toEqual([
      "Package signed app",
      "Package notarized artifacts",
      "Package app",
    ])

    const prepare = indexOfStep("Prepare uv and bundled Python")
    expect(prepare).toBeGreaterThanOrEqual(0)
    for (const step of packaging) expect(steps.indexOf(step)).toBeGreaterThan(prepare)
    expect(steps[prepare].body).toMatch(/prepare-uv\.ts/)
    expect(steps[prepare].body).toMatch(/prepare-primary-runtime\.ts/)
    expect(steps[prepare].body).toMatch(/uv_platform="darwin"/)
    expect(steps[prepare].body).toMatch(/uv_platform="win32"/)
  })

  test("keeps the two-phase notarization split intact", () => {
    // Packing a fresh bundle in the finalize phase would discard the notarized
    // one; --prepackaged is what makes the shipped dmg the stapled build.
    const submit = steps[indexOfStep("Package signed app")]
    const finalize = steps[indexOfStep("Package notarized artifacts")]
    // A distributable target makes electron-builder write app-update.yml into
    // the bundle before signing; the dir-only target deliberately skips it.
    expect(submit.body).toMatch(/electron-builder --mac zip .*--publish never/)
    expect(finalize.body).toMatch(/electron-builder --mac dmg zip .*--prepackaged "\$APP_PATH"/)
  })

  test("verifies the notarized bundle's signature and updater target in both artifacts", () => {
    const verify = steps[indexOfStep("Verify notarized artifacts")]
    expect(verify.body).toMatch(/codesign --verify --deep --strict/)
    // The zip and the dmg are packed separately, so both copies are checked.
    expect(verify.body).toMatch(/verify_app_update_config "\$verify_dir\//)
    expect(verify.body).toMatch(/verify_app_update_config "\$mounted_app\//)
    expect(verify.body).toMatch(/grep -qx "repo: \$PUBLISH_REPO"/)
    expect(verify.body).toMatch(/grep -qx "channel: latest-v2"/)
  })

  test("installs and smokes a production Windows installer before upload without signing infrastructure", () => {
    const pack = indexOfStep("Package app")
    const install = indexOfStep("Verify and install Windows package")
    const smoke = indexOfStep("Smoke installed Windows package")
    const upload = indexOfStep("Upload packaged app artifact")

    expect(pack).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(pack)
    expect(smoke).toBeGreaterThan(install)
    expect(upload).toBeGreaterThan(smoke)
    expect(steps[install].body).toMatch(/latest-v2/)
    expect(steps[smoke].body).toMatch(/ci-smoke\.ts packaged prod/)
    expect(workflow).not.toMatch(/azure\/login|AZURE_|Get-AuthenticodeSignature|signtoolOptions/)
  })

  // The finalizer merges the other arch's entries into this channel's feed, so
  // the repository it reads from and the one it writes to have to be the same
  // one — reading metadata from the wrong release into this feed puts an
  // unrelated sha512 under the live pointer and updater verification fails.
  test("finalizes updater metadata in the repository the build publishes to", () => {
    const finalize = steps.find((step) => /finalize-latest-yml\.ts/.test(step.body))
    const predownload = steps[indexOfStep("Download existing updater metadata")]
    expect(finalize).toBeDefined()
    expect(finalize!.body).toMatch(/inputs\.channel != 'dev'/)
    expect(finalize!.body).toMatch(/GH_REPO: \$\{\{ env\.PUBLISH_OWNER \}\}\/\$\{\{ env\.PUBLISH_REPO \}\}/)
    expect(predownload.body).toMatch(/--repo "\$PUBLISH_OWNER\/\$PUBLISH_REPO"/)
    expect(predownload.body).toMatch(/inputs\.channel != 'dev'/)
    // Dev builds write no updater metadata, so collecting it runs only where finalizing does.
    expect(conditionOfStep("Collect updater metadata")).toBe(conditionOfStep("Finalize updater metadata"))
  })
})
