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

const macros = new Map(
  [...script.matchAll(/^[^\S\r\n]*!macro (\w+)\r?\n([\s\S]*?)\r?\n[^\S\r\n]*!macroend/gm)]
    .map((match) => [match[1], match[2]]),
)

// Three copies of the channel table: name the shortcut, delete it, delete it
// elevated. Comparing the names as one set could not see a channel missing from
// one of the three, which is exactly how the elevated arm would go quiet: beta's
// Public Desktop shortcut simply never removed. Each table is checked on its own,
// and each arm has to mention the Chinese name app-identity derives.
describe.each([
  "PAWWORK_STANDARD_SHORTCUT",
  "PAWWORK_REMOVE_STANDARD_SHORTCUTS",
  "PAWWORK_REMOVE_PUBLIC_STANDARD_SHORTCUTS_ELEVATED",
])("%s", (name) => {
  const macro = macros.get(name)
  // Anchored on the SHORTCUT_NAME comparison: an unrelated quoted condition
  // above it (the elevated table has two) would otherwise open an arm whose
  // lazy body swallows the first real one.
  const arms = [
    ...(macro ?? "").matchAll(/"\$\{SHORTCUT_NAME\}" == "([^"]+)"([\s\S]*?)(?=\$\{ElseIf\}|\$\{EndIf\})/g),
  ]

  test("has one arm per channel, naming it in Chinese", () => {
    expect(macro, `${name} is missing`).toBeDefined()
    expect(arms.map((match) => match[1]).sort()).toEqual([...appNames].sort())
    for (const [, channel, body] of arms) {
      expect(body, `${name} / ${channel}`).toContain(localizedPawWorkName(channel))
    }
  })
})

describe("windows nsis desktop shortcut customization", () => {
  // electron-builder looks these two up by name. Rename either and the checkbox
  // page, or the whole shortcut-creation block, silently leaves the installer.
  test("uses the hook names electron-builder calls", () => {
    expect(macros.has("customPageAfterChangeDir")).toBe(true)
    expect(macros.has("customInstall")).toBe(true)
  })

  test("localizes the shortcut it creates, not only the ones it deletes", () => {
    // The StrCpy table is what names the shortcut that actually gets created;
    // the delete tables only clean up. Without the language check every zh_CN
    // installer would create PawWork.lnk and leave 爪印.lnk behind forever.
    const naming = macros.get("PAWWORK_STANDARD_SHORTCUT")!
    expect(naming).toContain("$LANGUAGE == 2052")
    expect(naming.match(/\$LANGUAGE == 2052/g)).toHaveLength(appNames.length)
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
