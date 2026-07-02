import type { Page } from "@playwright/test"
import { test } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 } })

async function waitForPinnedSection(page: Page, sessionId: string) {
  const sidebar = page.locator(pawworkSidebarSelector)
  await sidebar
    .locator(`[data-component="pawwork-sidebar-pinned"] [data-session-id="${sessionId}"]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
  return sidebar
}

test("sidebar-pinned", async ({ page, sdk, directory, gotoSession }) => {
  test.setTimeout(180_000)

  // Two sessions so the recent section also has content alongside pinned —
  // visually documents the section header + divider + row layout together.
  await withSession(sdk, "snap sidebar pinned a", async (a) => {
    await withSession(sdk, "snap sidebar pinned b", async (b) => {
      await gotoSession(b.id)

      // Seed the persisted layout-page store so session A is pinned on hydrate.
      // Persist key: GLOBAL_STORAGE ("pawwork.global.dat") + "layout-page" — see
      // packages/app/src/utils/persist.ts and pages/layout/layout-page-store.ts.
      // Schema: { pawworkPinnedSessions: string[], pawworkSortMode, ... }.
      await page.evaluate(
        ({ pinnedID }) => {
          const stored = JSON.stringify({
            pawworkPinnedSessions: [pinnedID],
            pawworkSortMode: "time",
            pawworkProjectCollapsed: {},
          })
          window.localStorage.setItem("pawwork.global.dat:layout-page", stored)
        },
        { pinnedID: a.id },
      )

      // Reload so the layout-page store hydrates from the seeded localStorage.
      await page.reload()
      await openSidebar(page)
      let sidebar = await waitForPinnedSection(page, a.id)
      const lightShot: Shot = { name: "light-pinned", buf: await sidebar.screenshot() }

      await applyDarkModeForTests(page)
      await openSidebar(page)
      sidebar = await waitForPinnedSection(page, a.id)
      const darkShot: Shot = { name: "dark-pinned", buf: await sidebar.screenshot() }

      const out = snapOutputPath("sidebar-pinned")
      await composeGrid([lightShot, darkShot], out)
      process.stdout.write(`\n[snap] sidebar-pinned grid -> ${out}\n\n`)
    })
  })

  // Suppress the unused-binding warning for `directory` — kept for parity with
  // other sidebar snaps that need it (e.g. sidebar-unread); harmless here.
  void directory
})
