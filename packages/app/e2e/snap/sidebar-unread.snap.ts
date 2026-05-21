import type { Page } from "@playwright/test"
import { test } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 } })

async function waitForUnreadDot(page: Page, sessionId: string) {
  const sidebar = page.locator(pawworkSidebarSelector)
  await sidebar
    .locator(`[data-session-id="${sessionId}"] [role="img"][aria-label]`)
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
  return sidebar
}

test("sidebar-unread", async ({ page, sdk, directory, gotoSession }) => {
  test.setTimeout(180_000)

  await withSession(sdk, "snap sidebar unread a", async (a) => {
    await withSession(sdk, "snap sidebar unread b", async (b) => {
      // Land the user on session B so session A is the one that "finished
      // a turn while the user was elsewhere". markViewed only fires for the
      // current session, so A keeps its unseen state intact.
      await gotoSession(b.id)

      // Inject a turn-complete notification for session A directly into the
      // persisted notification store. The notification context rebuilds its
      // unseen index from this list on load, so the sidebar's statusKind
      // memo will see unseenCount(a.id) > 0 and render the unread dot.
      // Persist key derivation: Persist.global("notification") uses storage
      // prefix "pawwork.global.dat" and key "notification" — see
      // packages/app/src/utils/persist.ts and persist-local-storage.ts.
      await page.evaluate(
        ({ sessionId, dir }) => {
          const stored = JSON.stringify({
            list: [
              {
                type: "turn-complete",
                time: Date.now(),
                viewed: false,
                session: sessionId,
                directory: dir,
              },
            ],
          })
          window.localStorage.setItem("pawwork.global.dat:notification", stored)
        },
        { sessionId: a.id, dir: directory },
      )

      // Reload so NotificationProvider hydrates from the seeded localStorage.
      await page.reload()
      await openSidebar(page)
      let sidebar = await waitForUnreadDot(page, a.id)
      const lightShot: Shot = { name: "light-unread", buf: await sidebar.screenshot() }

      // applyDarkModeForTests reloads the page; localStorage notification key
      // survives, so the unread dot rehydrates the same way.
      await applyDarkModeForTests(page)
      await openSidebar(page)
      sidebar = await waitForUnreadDot(page, a.id)
      const darkShot: Shot = { name: "dark-unread", buf: await sidebar.screenshot() }

      const out = snapOutputPath("sidebar-unread")
      await composeGrid([lightShot, darkShot], out)
      process.stdout.write(`\n[snap] sidebar-unread grid -> ${out}\n\n`)
    })
  })
})
