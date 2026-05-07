import { test, expect, settingsKey } from "../fixtures"

const RELEASES_URL_PATTERN = "**/api.github.com/repos/Astro-Han/pawwork/releases**"
const HIGHLIGHTS_KEY = "highlights.v1"

const singleReleasePayload = [
  {
    tag_name: "v2026.5.7",
    body: [
      "## App Update Notice",
      "",
      "Important refresh for this release.",
      "",
      "- Added subtle toast variant",
      "- Replaced release notes dialog",
    ].join("\n"),
  },
]

const multiVersionPayload = [
  {
    tag_name: "v2026.5.7",
    body: "## App Update Notice\n\n- Newest highlight A\n- Newest highlight B\n",
  },
  {
    tag_name: "v2026.5.6",
    body: "## App Update Notice\n\n- Older highlight C\n",
  },
]

const localizedPayload = [
  {
    tag_name: "v2026.5.7",
    body: [
      "## App Update Notice",
      "",
      "- English bullet only",
      "",
      "## 中文版本",
      "",
      "### 主要更新",
      "",
      "- 中文要点 A",
      "- 中文要点 B",
    ].join("\n"),
  },
]

const toastSelector = '[data-component="toast"][data-variant="subtle"]'
const toastTitleSelector = `${toastSelector} [data-slot="toast-title"]`
const toastDescriptionSelector = `${toastSelector} [data-slot="toast-description"]`
const toastActionSelector = `${toastSelector} [data-slot="toast-action"]`
const toastCloseButtonSelector = `${toastSelector} [data-slot="toast-close-button"]`
const toastIconSelector = `${toastSelector} [data-slot="toast-icon"]`

test.describe("release notes toast", () => {
  test("@smoke shows subtle toast when stored version is older than current", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(singleReleasePayload),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.6" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(toastTitleSelector)).toHaveText("Updated to v2026.5.7")
    await expect(page.locator(toastDescriptionSelector)).toContainText("Important refresh for this release.")
    await expect(page.locator(toastDescriptionSelector)).toContainText("• Added subtle toast variant")
    await expect(page.locator(toastDescriptionSelector)).toContainText("• Replaced release notes dialog")
    await expect(page.locator(toastActionSelector)).toHaveText("Full release notes →")
    await expect(page.locator(toastIconSelector)).toBeVisible()
  })

  test("clicking the close button marks the current version as seen", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(singleReleasePayload),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.6" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()
    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 10_000 })

    await page.locator(toastCloseButtonSelector).click()
    await expect(page.locator(toastSelector)).toBeHidden()

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? (JSON.parse(raw)?.version ?? null) : null
        }, HIGHLIGHTS_KEY),
      )
      .toBe("2026.5.7")
  })

  test("releaseNotes=false suppresses the toast", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(singleReleasePayload),
      })
    })

    await page.addInitScript(
      ([highlightsKey, settingsStorageKey]) => {
        localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.6" }))
        const existing = localStorage.getItem(settingsStorageKey)
        const parsed = existing ? JSON.parse(existing) : {}
        parsed.general = { ...(parsed.general ?? {}), releaseNotes: false }
        localStorage.setItem(settingsStorageKey, JSON.stringify(parsed))
      },
      [HIGHLIGHTS_KEY, settingsKey],
    )

    await gotoSession()

    // releaseNotes=false short-circuits start() to call markSeen() synchronously,
    // so polling localStorage is the deterministic readiness signal that the
    // controller has run. Once the version advances, we know the toast was
    // suppressed (not merely "not yet rendered").
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? (JSON.parse(raw)?.version ?? null) : null
        }, HIGHLIGHTS_KEY),
      )
      .toBe("2026.5.7")
    await expect(page.locator(toastSelector)).toHaveCount(0)
  })

  test("merges multiple skipped versions into one description", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(multiVersionPayload),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.5" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(toastTitleSelector)).toHaveText("Updated to v2026.5.7")
    const description = page.locator(toastDescriptionSelector)
    await expect(description).toContainText("• Newest highlight A")
    await expect(description).toContainText("• Newest highlight B")
    await expect(description).toContainText("v2026.5.6")
    await expect(description).toContainText("• Older highlight C")
  })

  test("falls back to English when zh release section is missing", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            tag_name: "v2026.5.7",
            body: "## App Update Notice\n\n- English fallback bullet\n",
          },
        ]),
      })
    })

    await page.addInitScript((highlightsKey) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.6" }))
      localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 10_000 })
    // Title and action must follow the parsed body's locale (en) — never mix with zh UI locale.
    await expect(page.locator(toastTitleSelector)).toHaveText("Updated to v2026.5.7")
    await expect(page.locator(toastActionSelector)).toHaveText("Full release notes →")
    await expect(page.locator(toastDescriptionSelector)).toContainText("• English fallback bullet")
  })

  test("uses zh title and action when zh release section is present", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(localizedPayload),
      })
    })

    await page.addInitScript((highlightsKey) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.6" }))
      localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(toastSelector)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(toastTitleSelector)).toHaveText("已更新到 v2026.5.7")
    await expect(page.locator(toastActionSelector)).toHaveText("查看完整发布说明 →")
    await expect(page.locator(toastDescriptionSelector)).toContainText("• 中文要点 A")
    await expect(page.locator(toastDescriptionSelector)).toContainText("• 中文要点 B")
  })
})
