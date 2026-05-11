import { test, expect, settingsKey } from "../fixtures"

const RELEASES_URL_PATTERN = "**/api.github.com/repos/Astro-Han/pawwork/releases**"
const HIGHLIGHTS_KEY = "highlights.v1"
const LANGUAGE_KEY = "pawwork.global.dat:language"

const SINGLE_RELEASE_PAYLOAD = [
  {
    tag_name: "v2026.5.12",
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

const MULTI_VERSION_PAYLOAD = [
  {
    tag_name: "v2026.5.12",
    body: "## App Update Notice\n\n- Newest highlight A\n- Newest highlight B\n",
  },
  {
    tag_name: "v2026.5.10",
    body: "## App Update Notice\n\n- Older highlight C\n",
  },
]

const LOCALIZED_PAYLOAD = [
  {
    tag_name: "v2026.5.12",
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

const TOAST_SELECTOR = '[data-component="toast"][data-variant="subtle"]'
const TOAST_TITLE_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-title"]`
const TOAST_DESCRIPTION_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-description"]`
const TOAST_MARKDOWN_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-markdown"]`
const TOAST_ACTION_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-action"]`
const TOAST_CLOSE_BUTTON_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-close-button"]`
const TOAST_ICON_SELECTOR = `${TOAST_SELECTOR} [data-slot="toast-icon"]`

test.describe("release notes toast", () => {
  test("@smoke shows subtle toast when stored version is older than current", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SINGLE_RELEASE_PAYLOAD),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.10" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("Updated to v2026.5.12")
    // Content is now rendered as HTML in the toast-markdown slot
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("Important refresh for this release.")
    await expect(page.locator(`${TOAST_MARKDOWN_SELECTOR} li`)).toContainText(["Added subtle toast variant", "Replaced release notes dialog"])
    await expect(page.locator(TOAST_ACTION_SELECTOR)).toHaveText("Full release notes →")
    await expect(page.locator(TOAST_ICON_SELECTOR)).toBeVisible()
  })

  test("clicking the close button marks the current version as seen", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SINGLE_RELEASE_PAYLOAD),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.10" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()
    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })

    await page.locator(TOAST_CLOSE_BUTTON_SELECTOR).click()
    await expect(page.locator(TOAST_SELECTOR)).toBeHidden()

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? (JSON.parse(raw)?.version ?? null) : null
        }, HIGHLIGHTS_KEY),
      )
      .toBe("2026.5.12")
  })

  test("clicking the action opens the release URL and marks the current version as seen", async ({
    page,
    gotoSession,
  }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SINGLE_RELEASE_PAYLOAD),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.10" }))
      // Capture window.open calls so we can assert the action opened the
      // expected release URL. platform.openLink in the web shell calls
      // window.open(url, "_blank"); stubbing it avoids opening a real popup.
      const captured: string[] = []
      ;(window as unknown as { __OPENED_LINKS: string[] }).__OPENED_LINKS = captured
      window.open = ((url?: string | URL) => {
        if (typeof url === "string") captured.push(url)
        else if (url) captured.push(url.toString())
        return null
      }) as typeof window.open
    }, HIGHLIGHTS_KEY)

    await gotoSession()
    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })

    await page.locator(TOAST_ACTION_SELECTOR).click()
    await expect(page.locator(TOAST_SELECTOR)).toBeHidden()

    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __OPENED_LINKS: string[] }).__OPENED_LINKS),
      )
      .toContain("https://github.com/Astro-Han/pawwork/releases/tag/v2026.5.12")

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? (JSON.parse(raw)?.version ?? null) : null
        }, HIGHLIGHTS_KEY),
      )
      .toBe("2026.5.12")
  })

  test("pressing Escape marks the current version as seen", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SINGLE_RELEASE_PAYLOAD),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.10" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()
    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })

    // Escape key dismisses via Kobalte's onEscapeKeyDown → close() path,
    // which bypasses CloseButton's onClick. This guards the same code path
    // used by swipe-to-dismiss on touch devices: both must mark the version
    // as seen via the onSwipeEnd / onEscapeKeyDown handlers we add to the
    // Toast root, otherwise the toast re-shows on next launch.
    await page.locator(TOAST_SELECTOR).focus()
    await page.keyboard.press("Escape")
    await expect(page.locator(TOAST_SELECTOR)).toBeHidden()

    await expect
      .poll(() =>
        page.evaluate((key) => {
          const raw = localStorage.getItem(key)
          return raw ? (JSON.parse(raw)?.version ?? null) : null
        }, HIGHLIGHTS_KEY),
      )
      .toBe("2026.5.12")
  })

  test("releaseNotes=false suppresses the toast", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SINGLE_RELEASE_PAYLOAD),
      })
    })

    await page.addInitScript(
      ([highlightsKey, settingsStorageKey]) => {
        localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.10" }))
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
      .toBe("2026.5.12")
    await expect(page.locator(TOAST_SELECTOR)).toHaveCount(0)
  })

  test("merges multiple skipped versions into one description", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MULTI_VERSION_PAYLOAD),
      })
    })

    await page.addInitScript((key) => {
      localStorage.setItem(key, JSON.stringify({ version: "2026.5.5" }))
    }, HIGHLIGHTS_KEY)

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("Updated to v2026.5.12")
    const markdown = page.locator(TOAST_MARKDOWN_SELECTOR)
    await expect(markdown).toContainText("Newest highlight A")
    await expect(markdown).toContainText("Newest highlight B")
    await expect(markdown).toContainText("v2026.5.10")
    await expect(markdown).toContainText("Older highlight C")
    // All bullets must be rendered as <li> elements — both newest and multi-version older
    await expect(page.locator(`${TOAST_MARKDOWN_SELECTOR} li`)).toContainText([
      "Newest highlight A",
      "Newest highlight B",
      "Older highlight C",
    ])
  })

  test("falls back to English when zh release section is missing", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            tag_name: "v2026.5.12",
            body: "## App Update Notice\n\n- English fallback bullet\n",
          },
        ]),
      })
    })

    await page.addInitScript(([highlightsKey, languageKey]) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.6" }))
      localStorage.setItem(languageKey, JSON.stringify({ locale: "zh" }))
    }, [HIGHLIGHTS_KEY, LANGUAGE_KEY])

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    // Title and action must follow the parsed body's locale (en) — never mix with zh UI locale.
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("Updated to v2026.5.12")
    await expect(page.locator(TOAST_ACTION_SELECTOR)).toHaveText("Full release notes →")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("English fallback bullet")
  })

  test("uses zh title and action when zh release section is present", async ({ page, gotoSession }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(LOCALIZED_PAYLOAD),
      })
    })

    await page.addInitScript(([highlightsKey, languageKey]) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.6" }))
      localStorage.setItem(languageKey, JSON.stringify({ locale: "zh" }))
    }, [HIGHLIGHTS_KEY, LANGUAGE_KEY])

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("已更新到 v2026.5.12")
    await expect(page.locator(TOAST_ACTION_SELECTOR)).toHaveText("查看完整发布说明 →")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("中文要点 A")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("中文要点 B")
  })

  test("title and link anchor on the app's current version even when its release lacks a notice in the resolved locale", async ({
    page,
    gotoSession,
  }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            tag_name: "v2026.5.12",
            // newest release: zh-only notice, no English App Update Notice
            body: ["## 中文版本", "", "### 主要更新", "", "- 仅中文要点"].join("\n"),
          },
          {
            tag_name: "v2026.5.10",
            // older skipped release: en-only notice, no 中文版本
            body: "## App Update Notice\n\n- older en-only bullet\n",
          },
        ]),
      })
    })

    await page.addInitScript(([highlightsKey, languageKey]) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.9" }))
      localStorage.setItem(languageKey, JSON.stringify({ locale: "zh" }))
    }, [HIGHLIGHTS_KEY, LANGUAGE_KEY])

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    // First-pass zh resolves to mixed (v2026.5.12 zh + v2026.5.10 en fallback),
    // so we re-resolve the whole window in English. The English window does
    // not contain v2026.5.12 (no App Update Notice there), but the title and
    // link must still anchor on the app's current version, not summaries[0].
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("Updated to v2026.5.12")
    await expect(page.locator(TOAST_ACTION_SELECTOR)).toHaveText("Full release notes →")
    // Markdown slot's first segment must carry the v2026.5.10 tag, otherwise
    // the older release's bullet would read as if it described the current
    // version (the title says v2026.5.12 but summaries[0] here is v2026.5.10
    // because the English fallback dropped v2026.5.12).
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("v2026.5.10")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("older en-only bullet")
  })

  test("falls back to English across the whole window when an older skipped release has no zh section", async ({
    page,
    gotoSession,
  }) => {
    await page.route(RELEASES_URL_PATTERN, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            tag_name: "v2026.5.12",
            body: [
              "## App Update Notice",
              "",
              "- newest en bullet",
              "",
              "## 中文版本",
              "",
              "### 主要更新",
              "",
              "- 最新中文 bullet",
            ].join("\n"),
          },
          {
            tag_name: "v2026.5.10",
            body: "## App Update Notice\n\n- older en only\n",
          },
        ]),
      })
    })

    await page.addInitScript(([highlightsKey, languageKey]) => {
      localStorage.setItem(highlightsKey, JSON.stringify({ version: "2026.5.9" }))
      localStorage.setItem(languageKey, JSON.stringify({ locale: "zh" }))
    }, [HIGHLIGHTS_KEY, LANGUAGE_KEY])

    await gotoSession()

    await expect(page.locator(TOAST_SELECTOR)).toBeVisible({ timeout: 10_000 })
    // The newest release has a zh section but the older skipped release does
    // not. Spec #486 forbids mixing languages, so the entire toast — title,
    // action, and every segment — must be English.
    await expect(page.locator(TOAST_TITLE_SELECTOR)).toHaveText("Updated to v2026.5.12")
    await expect(page.locator(TOAST_ACTION_SELECTOR)).toHaveText("Full release notes →")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("newest en bullet")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).toContainText("older en only")
    await expect(page.locator(TOAST_MARKDOWN_SELECTOR)).not.toContainText("中文")
  })
})
