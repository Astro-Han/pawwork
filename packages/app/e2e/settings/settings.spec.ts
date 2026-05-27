import { test, expect, settingsKey } from "../fixtures"
import { closeDialog, closeSettingsPanel, openSettings } from "../actions"
import {
  settingsCodeFontSelector,
  settingsLanguageSelectSelector,
  settingsReleaseNotesSelector,
  settingsUIFontSelector,
  settingsUpdatesStartupSelector,
  titlebarCenterSelector,
} from "../selectors"

test("@smoke new installs start with the PawWork theme", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("pawwork-theme-id")
    localStorage.removeItem("pawwork-color-scheme")
  })

  await gotoSession()

  await expect(page.locator("html")).toHaveAttribute("data-theme", "pawwork")
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "light")
})

test("@smoke settings dialog opens, switches tabs, closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)

  await dialog.getByRole("tab", { name: "Shortcuts" }).click()
  await expect(dialog.getByRole("button", { name: "Reset to defaults" })).toBeVisible()
  await expect(dialog.getByPlaceholder("Search shortcuts")).toBeVisible()

  await closeSettingsPanel(page, dialog)
})

test('@smoke PawWork settings opens as a full-pane surface, not a dialog', async ({ page, gotoSession }) => {
  await gotoSession()

  await openSettings(page)

  await expect(page.locator('[data-component="settings-page"]')).toBeVisible()
  await expect(page.locator('[data-component="dialog-overlay"]')).toHaveCount(0)
  // 新壳把标题挪到标题栏（PawworkTitlebar），页面内不再有 h1；壳子 section 带 aria-label 提供无障碍名。
  await expect(page.getByRole("region", { name: "Settings" })).toBeVisible()
  await expect(page.locator(titlebarCenterSelector)).toContainText("Settings")
})

test("changing language updates settings labels", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "en" }))
  })

  await gotoSession()

  const dialog = await openSettings(page)

  const heading = dialog.getByRole("heading", { level: 2 })
  await expect(heading).toHaveText("General")

  const select = dialog.locator(settingsLanguageSelectSelector)
  await expect(select).toBeVisible()
  await select.locator('[data-slot="select-select-trigger"]').click()

  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "简体中文" }).click()

  await expect(heading).toHaveText("通用")

  await select.locator('[data-slot="select-select-trigger"]').click()
  await page.locator('[data-slot="select-select-item"]').filter({ hasText: "English" }).click()
  await expect(heading).toHaveText("General")
})

test.skip("changing color scheme persists in localStorage", async () => {
  // Phase-1 ships a single pawwork theme that is locked to light mode, so the
  // color-scheme select cannot exercise dark ↔ light switching. Revisit when a
  // real dark palette or a second theme lands.
})

test.skip("changing theme persists in localStorage", async () => {
  // Phase-1 only bundles the pawwork theme; the theme select has a single entry
  // and cannot exercise switching. Revisit once a second theme is added.
})

test("unknown theme ids migrate to pawwork and clear cached css", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    localStorage.setItem("pawwork-theme-id", "dracula")
    localStorage.setItem("pawwork-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("pawwork-theme-css-dark", "--background-base:#000;")
  })

  await gotoSession()

  await expect(page.locator("html")).toHaveAttribute("data-theme", "pawwork")

  await expect
    .poll(async () => {
      return await page.evaluate(() => {
        return localStorage.getItem("pawwork-theme-id")
      })
    })
    .toBe("pawwork")

  // 迁移到 pawwork 后，属于旧主题（dracula）的缓存 CSS 不能再生效：preload 清空、
  // 运行时 ThemeProvider 写入 pawwork 真实 CSS 覆盖。断言旧假值不再残留即可。
  await expect
    .poll(async () => {
      return await page.evaluate(() => localStorage.getItem("pawwork-theme-css-light"))
    })
    .not.toBe("--background-base:#fff;")

  await expect
    .poll(async () => {
      return await page.evaluate(() => localStorage.getItem("pawwork-theme-css-dark"))
    })
    .not.toBe("--background-base:#000;")
})

test("typing a code font with spaces persists and updates CSS variable", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const input = dialog.locator(settingsCodeFontSelector)
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute("placeholder", "System Mono")

  const initialFontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  const initialUIFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  expect(initialFontFamily).toContain("ui-monospace")

  const next = "Test Mono"

  await input.click()
  await input.clear()
  await input.pressSequentially(next)
  await expect(input).toHaveValue(next)

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        mono: next,
      },
    })

  const newFontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  const newUIFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  expect(newFontFamily).toContain(next)
  expect(newFontFamily).not.toBe(initialFontFamily)
  expect(newUIFamily).toBe(initialUIFamily)
})

test("typing a UI font with spaces persists and updates CSS variable", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const input = dialog.locator(settingsUIFontSelector)
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute("placeholder", "System Sans")

  const initialFontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  const initialCodeFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  expect(initialFontFamily).toContain("system-ui")

  const next = "Test Sans"

  await input.click()
  await input.clear()
  await input.pressSequentially(next)
  await expect(input).toHaveValue(next)

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        sans: next,
      },
    })

  const newFontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  const newCodeFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  expect(newFontFamily).toContain(next)
  expect(newFontFamily).not.toBe(initialFontFamily)
  expect(newCodeFamily).toBe(initialCodeFamily)
})

test("clearing the code font field restores the default placeholder and stack", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const input = dialog.locator(settingsCodeFontSelector)
  await expect(input).toBeVisible()

  await input.click()
  await input.clear()
  await input.pressSequentially("Reset Mono")

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        mono: "Reset Mono",
      },
    })

  await input.clear()
  await input.press("Space")
  await expect(input).toHaveValue("")
  await expect(input).toHaveAttribute("placeholder", "System Mono")

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        mono: "",
      },
    })

  const fontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  expect(fontFamily).toContain("ui-monospace")
  expect(fontFamily).not.toContain("Reset Mono")
})

test("clearing the UI font field restores the default placeholder and stack", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const input = dialog.locator(settingsUIFontSelector)
  await expect(input).toBeVisible()

  await input.click()
  await input.clear()
  await input.pressSequentially("Reset Sans")

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        sans: "Reset Sans",
      },
    })

  await input.clear()
  await input.press("Space")
  await expect(input).toHaveValue("")
  await expect(input).toHaveAttribute("placeholder", "System Sans")

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        sans: "",
      },
    })

  const fontFamily = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  expect(fontFamily).toContain("system-ui")
  expect(fontFamily).not.toContain("Reset Sans")
})

test("code font and UI font rehydrate after reload", async ({ page, gotoSession }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("settings-rehydrate-init")) return
    localStorage.setItem("pawwork-theme-id", "pawwork")
    localStorage.setItem("pawwork-color-scheme", "light")
    sessionStorage.setItem("settings-rehydrate-init", "1")
  })

  await gotoSession()

  const dialog = await openSettings(page)

  const code = dialog.locator(settingsCodeFontSelector)
  const ui = dialog.locator(settingsUIFontSelector)
  await expect(code).toBeVisible()
  await expect(ui).toBeVisible()

  const initialMono = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  const initialSans = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )

  const initialSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  const mono = initialSettings?.appearance?.mono === "Reload Mono" ? "Reload Mono 2" : "Reload Mono"
  const sans = initialSettings?.appearance?.sans === "Reload Sans" ? "Reload Sans 2" : "Reload Sans"

  await code.click()
  await code.clear()
  await code.pressSequentially(mono)
  await expect(code).toHaveValue(mono)

  await ui.click()
  await ui.clear()
  await ui.pressSequentially(sans)
  await expect(ui).toHaveValue(sans)

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        mono,
        sans,
      },
    })

  const updatedSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  const updatedMono = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  const updatedSans = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  expect(updatedMono).toContain(mono)
  expect(updatedMono).not.toBe(initialMono)
  expect(updatedSans).toContain(sans)
  expect(updatedSans).not.toBe(initialSans)
  expect(updatedSettings?.appearance?.mono).toBe(mono)
  expect(updatedSettings?.appearance?.sans).toBe(sans)

  await closeSettingsPanel(page, dialog)
  await page.reload()

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({
      appearance: {
        mono,
        sans,
      },
    })

  const rehydratedSettings = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
      )
    })
    .toContain(mono)

  await expect
    .poll(async () => {
      return await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
      )
    })
    .toContain(sans)

  const rehydratedMono = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-mono").trim(),
  )
  const rehydratedSans = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-family-sans").trim(),
  )
  expect(rehydratedMono).toContain(mono)
  expect(rehydratedMono).not.toBe(initialMono)
  expect(rehydratedSans).toContain(sans)
  expect(rehydratedSans).not.toBe(initialSans)
  expect(rehydratedSettings?.appearance?.mono).toBe(mono)
  expect(rehydratedSettings?.appearance?.sans).toBe(sans)
})

test("changing notification level persists in localStorage", async ({ page, gotoSession }) => {
  // #923 把多个通知开关 + 音效选择合并成单个 tri-state（never / unfocused / always）；
  // 旧的 settings-notifications-* / settings-sounds-* 控件已删，这里测合并后的单控件。
  await gotoSession()

  const dialog = await openSettings(page)
  const select = dialog.locator('[data-action="settings-notify-level"]')
  await expect(select).toBeVisible()

  await select.locator('[data-slot="select-select-trigger"]').click()
  const items = page.locator('[data-slot="select-select-item"]')
  await expect(items).toHaveCount(3) // never / unfocused / always
  await items.nth(2).click() // always

  await expect
    .poll(async () => {
      return await page.evaluate((key) => {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : null
      }, settingsKey)
    })
    .toMatchObject({ notify: "always" })
})

test("toggling updates startup switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsUpdatesStartupSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')

  const isDisabled = await toggleInput.evaluate((el: HTMLInputElement) => el.disabled)
  if (isDisabled) {
    test.skip()
    return
  }

  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.updates?.startup).toBe(false)
})

test("toggling release notes switch updates localStorage", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openSettings(page)
  const switchContainer = dialog.locator(settingsReleaseNotesSelector)
  await expect(switchContainer).toBeVisible()

  const toggleInput = switchContainer.locator('[data-slot="switch-input"]')
  const initialState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(initialState).toBe(true)

  await switchContainer.locator('[data-slot="switch-control"]').click()
  await page.waitForTimeout(100)

  const newState = await toggleInput.evaluate((el: HTMLInputElement) => el.checked)
  expect(newState).toBe(false)

  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  }, settingsKey)

  expect(stored?.general?.releaseNotes).toBe(false)
})
