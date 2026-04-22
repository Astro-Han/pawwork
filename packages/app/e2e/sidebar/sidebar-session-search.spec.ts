import { test, expect } from "../fixtures"
import { openPalette } from "../actions"

test("command palette prioritizes pinned and recent PawWork sessions", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const older = await sdk.session.create({ title: `Alpha brief ${stamp}` }).then((r) => r.data)
  const pinned = await sdk.session.create({ title: `Mango brief ${stamp}` }).then((r) => r.data)
  const recent = await sdk.session.create({ title: `Zulu brief ${stamp}` }).then((r) => r.data)

  if (!older?.id || !pinned?.id || !recent?.id) throw new Error("missing session ids")

  await page.addInitScript((sessionID) => {
    localStorage.setItem(
      "pawwork.global.dat:layout.page",
      JSON.stringify({
        pawworkPinnedSessions: [sessionID],
        pawworkSortMode: "time",
      }),
    )
  }, pinned.id)

  await gotoSession(recent.id)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("pawwork.global.dat:layout.page")
        const next = raw ? (JSON.parse(raw) as { pawworkPinnedSessions?: string[] }).pawworkPinnedSessions : []
        return next ?? []
      }),
    )
    .toContain(pinned.id)

  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").fill("brief")

  const sessionRows = dialog.locator('[data-slot="list-item"][data-key^="session:"]')
  await expect(sessionRows.first()).toContainText(`Mango brief ${stamp}`)
})
