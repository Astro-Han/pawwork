import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")

function expectBefore(haystack: string, before: string, after: string) {
  const beforeIndex = haystack.indexOf(before)
  const afterIndex = haystack.indexOf(after)
  expect(beforeIndex).toBeGreaterThanOrEqual(0)
  expect(afterIndex).toBeGreaterThanOrEqual(0)
  expect(beforeIndex).toBeLessThan(afterIndex)
}

describe("release workflow app-update verification", () => {
  test("does not mutate app-update.yml after signing", () => {
    expect(workflow).not.toContain("write-app-update-config")
  })

  test("verifies app-update.yml in extracted zip artifact", () => {
    expect(workflow).toContain('verify_app_update_config "$verify_dir/$APP_NAME.app/Contents/Resources/app-update.yml"')
  })

  test("verifies codesign for extracted zip app", () => {
    expect(workflow).toContain('codesign --verify --deep --strict --verbose=2 "$verify_dir/$APP_NAME.app"')
  })

  test("verifies app-update.yml in mounted dmg artifact", () => {
    expect(workflow).toContain('verify_app_update_config "$mounted_app/Contents/Resources/app-update.yml"')
  })

  test("matches updater repo by exact line", () => {
    expect(workflow).toContain('grep -qx "repo: $expected_repo" "$config_path"')
  })

  test("keeps submit phase packaging as a signed app directory", () => {
    expect(workflow).toContain("npx electron-builder --mac dir --${{ matrix.arch_label }} --publish never")
  })

  test("keeps finalize phase packaging from the prepackaged signed app", () => {
    expect(workflow).toContain('npx electron-builder --mac dmg zip --${{ matrix.arch_label }} --prepackaged "$APP_PATH"')
  })

  test("prepares OfficeCLI before signed macOS packaging", () => {
    expectBefore(workflow, "Prepare OfficeCLI", "npx electron-builder --mac dir")
    expect(workflow).toContain("bun ./scripts/prepare-officecli.ts")
    expect(workflow).toContain('officecli_platform="darwin"')
  })

  test("prepares OfficeCLI before Windows packaging", () => {
    expectBefore(workflow, "Prepare OfficeCLI", "npx electron-builder ${{ matrix.platform_flag }}")
    expect(workflow).toContain('officecli_platform="win32"')
  })
})

const checklist = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "RELEASE_CHECKLIST.md"), "utf8")

describe("release checklist Windows installer verification", () => {
  test("records the Windows desktop shortcut verification matrix", () => {
    expect(checklist).toContain("English Windows fresh install")
    expect(checklist).toContain("Chinese Windows fresh install")
    expect(checklist).toContain("unchecked install")
    expect(checklist).toContain("reinstall with desktop shortcut checked")
    expect(checklist).toContain("reinstall with desktop shortcut unchecked")
    expect(checklist).toContain("scope switch between `Just me` and `All users`")
    expect(checklist).toContain("older standard `PawWork.lnk`")
    expect(checklist).toContain("app language change after install")
    expect(checklist).toContain("previous affected version")
    expect(checklist).toContain("no-desktop-shortcut state")
    expect(checklist).toContain("Do not close the Windows desktop shortcut issue")
  })
})
