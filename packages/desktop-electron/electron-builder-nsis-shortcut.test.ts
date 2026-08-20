import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { PAWWORK_APP, localizedPawWorkName } from "./src/main/app-identity"

// NSIS cannot be executed from a unit test, so this file does the two things
// that are actually checkable: bind the names the installer hard-codes to the
// table the app is built from, and assert that a step whose absence causes a
// known user-visible bug is still present.
const script = readFileSync(join(import.meta.dirname, "resources", "installer.nsh"), "utf8")

const appNames = Object.values(PAWWORK_APP).map((app) => app.name)

describe("windows nsis desktop shortcut customization", () => {
  test("knows exactly the channels PawWork ships", () => {
    const compared = [...script.matchAll(/"\$\{SHORTCUT_NAME\}" == "([^"]+)"/g)].map((match) => match[1])
    const localized = [...script.matchAll(/\$DESKTOP\\(爪印[^.]*)\.lnk/g)].map((match) => match[1])

    // Three copies of the channel table live in the script (name it, delete it,
    // delete it elevated), so each name is compared three times.
    expect(new Set(compared)).toEqual(new Set(appNames))
    expect(new Set(localized)).toEqual(new Set(appNames.map(localizedPawWorkName)))
  })

  test("offers the desktop shortcut checkbox in both installer languages", () => {
    const strings = new Map<string, Map<string, string>>()
    for (const [, name, language, value] of script.matchAll(/LangString (\w+) (\d+) "([^"]*)"/g)) {
      if (!strings.has(name)) strings.set(name, new Map())
      strings.get(name)!.set(language, value)
    }

    expect([...strings.keys()].sort()).toEqual(["PawWorkAddDesktopShortcut", "PawWorkShortcutOptions"])
    for (const [name, byLanguage] of strings) {
      // 1033 en_US, 2052 zh_CN — the two installerLanguages in the builder config.
      expect([...byLanguage.keys()].sort(), name).toEqual(["1033", "2052"])
      for (const value of byLanguage.values()) expect(value.length, name).toBeGreaterThan(0)
    }
  })

  test("declares the checkbox as a real custom page", () => {
    // Running page commands inline instead of from a page shipped an installer
    // whose checkbox never rendered.
    expect(script).toContain("PageEx custom")
    expect(script).toContain("PageCallbacks PawWorkDesktopShortcutPageCreate PawWorkDesktopShortcutPageLeave")
    expect(script).toMatch(/!ifndef BUILD_UNINSTALLER\r?\n[^\S\r\n]*Var AddDesktopShortcutCheckbox/)
  })

  test("leaves desktop shortcuts alone on auto-update", () => {
    // An update re-runs the installer; without the --updated guard it would
    // recreate a shortcut the user deleted, every release.
    expect(script).toContain("!include FileFunc.nsh")
    expect(script).toContain('"--updated"')
    expect(script).toContain("PAWWORK_SKIP_DESKTOP_SHORTCUT")
  })

  test("creates the shortcut only when checked, after clearing every install scope", () => {
    expect(script).toMatch(
      /\$AddDesktopShortcut == \$\{BST_CHECKED\}[\s\S]*PAWWORK_REMOVE_STANDARD_SHORTCUTS_IN_ALL_INSTALL_SCOPES[\s\S]*PAWWORK_RESTORE_INSTALL_SCOPE[\s\S]*CreateShortCut/,
    )
    // A per-user reinstall cannot delete a Public Desktop shortcut without it.
    expect(script).toContain("PAWWORK_REMOVE_PUBLIC_STANDARD_SHORTCUTS_ELEVATED")
    expect(script).toContain("${StdUtils.ExecShellWaitEx}")
  })

  test("removes on uninstall what it created, in the scope it installed to", () => {
    expect(script).toContain("customUnInstall")
    expect(script).toMatch(/PAWWORK_RESTORE_INSTALL_SCOPE\s+!insertmacro PAWWORK_REMOVE_STANDARD_SHORTCUTS/)
    expect(script).toContain("SetShellVarContext current")
    expect(script).toContain("SetShellVarContext all")
  })
})
