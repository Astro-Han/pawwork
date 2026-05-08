import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const script = readFileSync(join(import.meta.dir, "resources", "installer.nsh"), "utf8")

describe("windows nsis desktop shortcut customization", () => {
  test("adds an assisted installer checkbox with English and Chinese labels", () => {
    expect(script).toContain("AddDesktopShortcut")
    expect(script).toContain("添加桌面快捷方式")
    expect(script).toContain("Add desktop shortcut")
    expect(script).toContain('LangString PawWorkAddDesktopShortcut 1033 "Add desktop shortcut"')
    expect(script).toContain('LangString PawWorkAddDesktopShortcut 2052 "添加桌面快捷方式"')
    expect(script).not.toContain("LANG_ENGLISH")
    expect(script).not.toContain("LANG_SIMPCHINESE")
    expect(script).toContain("BST_CHECKED")
  })

  test("uses language-aware standard shortcut names", () => {
    expect(script).toContain("PawWork")
    expect(script).toContain("爪印")
    expect(script).toContain("$LANGUAGE")
  })

  test("does not mutate desktop shortcuts during auto-update", () => {
    expect(script).toContain("!include FileFunc.nsh")
    expect(script).toContain('"--updated"')
    expect(script).not.toContain("${isUpdated}")
    expect(script).not.toContain("!insertmacro skipPageIfUpdated")
    expect(script).toContain("PAWWORK_SKIP_DESKTOP_SHORTCUT")
  })

  test("keeps custom renamed shortcuts out of scope", () => {
    expect(script).toContain("PAWWORK_STANDARD_SHORTCUT")
    expect(script).not.toContain("我的 AI 工具")
  })

  test("declares a real custom page instead of running page commands inline", () => {
    expect(script).toContain("!ifndef BUILD_UNINSTALLER")
    expect(script).toContain("!ifndef BUILD_UNINSTALLER\n  Var AddDesktopShortcutCheckbox")
    expect(script).toContain("PageEx custom")
    expect(script).toContain("PageCallbacks PawWorkDesktopShortcutPageCreate PawWorkDesktopShortcutPageLeave")
    expect(script).toContain('Function "PawWorkDesktopShortcutPageCreate"')
    expect(script).toContain('Function "PawWorkDesktopShortcutPageLeave"')
  })

  test("uses channel-specific shortcut names instead of hard-coded prod names", () => {
    expect(script).toContain("${SHORTCUT_NAME}")
    expect(script).toContain('${If} "${SHORTCUT_NAME}" == "PawWork"')
    expect(script).toContain('$PawWorkStandardShortcutName == "爪印"')
  })

  test("owns uninstall and cross-scope cleanup for standard shortcuts", () => {
    expect(script).toContain("customUnInstall")
    expect(script).toContain("PAWWORK_REMOVE_STANDARD_SHORTCUTS")
    expect(script).toContain("SetShellVarContext current")
    expect(script).toContain("SetShellVarContext all")
    expect(script).toContain("PAWWORK_RESTORE_INSTALL_SCOPE")
    expect(script).toMatch(/PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_BOTH_SCOPES\s+!insertmacro PAWWORK_RESTORE_INSTALL_SCOPE/)
  })
})
