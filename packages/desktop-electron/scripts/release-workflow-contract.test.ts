import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// A unit test cannot prove what a shell workflow does — only that a step whose
// absence would ship an unverified or incomplete build is still there, and still
// ordered correctly. These read the workflow as steps rather than as text, so a
// reformat inside a step does not fail them and a deleted step does.
const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")

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

describe("release workflow", () => {
  test("bundles uv before anything packages the app", () => {
    const packaging = stepsRunning(/electron-builder .*(--mac|\$\{\{ matrix\.platform_flag \}\})/)
    // submit packs the signed directory, finalize repacks it into dmg/zip, and
    // Windows packs in one go.
    expect(packaging.map((step) => step.name)).toEqual([
      "Package signed app",
      "Package notarized artifacts",
      "Package app",
    ])

    const prepare = indexOfStep("Prepare uv")
    expect(prepare).toBeGreaterThanOrEqual(0)
    for (const step of packaging) expect(steps.indexOf(step)).toBeGreaterThan(prepare)
    expect(steps[prepare].body).toMatch(/prepare-uv\.ts/)
    expect(steps[prepare].body).toMatch(/uv_platform="darwin"/)
    expect(steps[prepare].body).toMatch(/uv_platform="win32"/)
  })

  test("keeps the two-phase notarization split intact", () => {
    // Packing a fresh bundle in the finalize phase would discard the notarized
    // one; --prepackaged is what makes the shipped dmg the stapled build.
    const submit = steps[indexOfStep("Package signed app")]
    const finalize = steps[indexOfStep("Package notarized artifacts")]
    expect(submit.body).toMatch(/electron-builder --mac dir .*--publish never/)
    expect(finalize.body).toMatch(/electron-builder --mac dmg zip .*--prepackaged "\$APP_PATH"/)
  })

  test("verifies the notarized bundle's signature and updater target in both artifacts", () => {
    const verify = steps[indexOfStep("Verify notarized artifacts")]
    expect(verify.body).toMatch(/codesign --verify --deep --strict/)
    // The zip and the dmg are packed separately, so both copies are checked.
    expect(verify.body).toMatch(/verify_app_update_config "\$verify_dir\//)
    expect(verify.body).toMatch(/verify_app_update_config "\$mounted_app\//)
    expect(verify.body).toMatch(/grep -qx "repo: \$PUBLISH_REPO"/)
  })

  test("finalizes updater metadata only for channels that publish", () => {
    const finalize = steps.find((step) => /finalize-latest-yml\.ts/.test(step.body))
    expect(finalize).toBeDefined()
    expect(finalize!.body).toMatch(/inputs\.channel != 'dev'/)
    expect(finalize!.body).toMatch(/inputs\.channel == 'beta' && 'Astro-Han\/pawwork-beta' \|\| github\.repository/)
  })
})
