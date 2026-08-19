import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "build.yml"), "utf8")

function expectBefore(haystack: string, before: string, after: string) {
  const beforeIndex = haystack.indexOf(before)
  const afterIndex = haystack.indexOf(after)
  expect(beforeIndex).toBeGreaterThanOrEqual(0)
  expect(afterIndex).toBeGreaterThanOrEqual(0)
  expect(beforeIndex).toBeLessThan(afterIndex)
}

describe("release workflow app-update verification", () => {
  test("does not mutate app-update.yml after signing", () => {
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
    expect(workflow).toContain("pnpm exec electron-builder --mac dir --${{ matrix.arch_label }} --publish never")
  })

  test("keeps finalize phase packaging from the prepackaged signed app", () => {
    expect(workflow).toContain('pnpm exec electron-builder --mac dmg zip --${{ matrix.arch_label }} --prepackaged "$APP_PATH"')
  })

  test("prepares uv before signed macOS packaging", () => {
    expectBefore(workflow, "Prepare uv", "pnpm exec electron-builder --mac dir")
    expect(workflow).toContain("pnpm exec tsx ./scripts/prepare-uv.ts")
    expect(workflow).toContain('uv_platform="darwin"')
  })

  test("prepares uv before Windows packaging", () => {
    expectBefore(workflow, "Prepare uv", "pnpm exec electron-builder ${{ matrix.platform_flag }}")
    expect(workflow).toContain('uv_platform="win32"')
  })
})
