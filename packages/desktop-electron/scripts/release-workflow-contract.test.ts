import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")

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
})
