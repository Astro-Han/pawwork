import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Remote control surface + connect flow. snap runs in web Chromium, which has no
// Electron preload, so window.api.remote is injected here as a stub: a mutable
// per-channel status the test drives via __remote.set(...), and a pairing-event
// emitter (__remote.emit) that walks the connect dialog through bind -> captured.
// One run snapshots every state the user sees — the page (disconnected / connected
// / degraded) and the connect dialog (Telegram token + message bind, captured
// confirm, disconnect). The IPC behind that API is covered by desktop-electron +
// remote-bridge unit tests.
test("remote-surface", async ({ page, project }) => {
  test.setTimeout(180_000)

  await page.addInitScript(() => {
    let status: Record<string, unknown> = { channels: [] }
    const statusListeners = new Set<(s: unknown) => void>()
    const pairingListeners = new Set<(e: unknown) => void>()
    ;(window as any).api = {
      ...(window as any).api,
      remote: {
        getStatus: () => Promise.resolve(status),
        startPairing: () => Promise.resolve(),
        cancelPairing: () => Promise.resolve(),
        confirmPairing: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        onStatus: (cb: (s: unknown) => void) => {
          statusListeners.add(cb)
          return () => statusListeners.delete(cb)
        },
        onPairing: (cb: (e: unknown) => void) => {
          pairingListeners.add(cb)
          return () => pairingListeners.delete(cb)
        },
      },
    }
    ;(window as any).__remote = {
      set: (s: Record<string, unknown>) => {
        status = s
        statusListeners.forEach((cb) => cb(status))
      },
      emit: (event: unknown) => pairingListeners.forEach((cb) => cb(event)),
    }
  })

  await project.open()
  await openSidebar(page)
  await page.locator('[data-action="pawwork-remote-open"]').click()
  const surface = page.locator('[data-component="remote-page"]')
  await surface.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = []

  // 1) Disconnected page — Telegram offers Connect.
  await surface.locator('[data-action="remote-connect-telegram"]').waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "disconnected", buf: await surface.screenshot() })

  // 2) Telegram — token step, then the message bind.
  await surface.locator('[data-action="remote-connect-telegram"]').click()
  let dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "telegram-token", buf: await dialog.screenshot() })
  await dialog.getByRole("textbox").first().fill("8403172:AAExampleBotTokenForPreview")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await dialog.getByText("Message the bot").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "telegram-bind", buf: await dialog.screenshot() })

  // 3) Captured → confirm (shared across platforms).
  await page.evaluate(() =>
    (window as any).__remote.emit({ phase: "captured", platform: "telegram", identity: { id: "8403172", name: "yuhan" } }),
  )
  await dialog.getByText("Allow this connection?").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "confirm", buf: await dialog.screenshot() })
  await dialog.getByRole("button", { name: "Close" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 4) Connected page — Telegram green + paired identity.
  await page.evaluate(() =>
    (window as any).__remote.set({
      channels: [{ platform: "telegram", state: "connected", identity: { id: "8403172", name: "yuhan" }, error: null }],
    }),
  )
  await surface.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "connected", buf: await surface.screenshot() })

  // 5) Disconnect confirm — only reachable while connected.
  await surface.locator('[data-action="remote-disconnect-telegram"]').click()
  const disconnectDialog = page.getByRole("dialog")
  await disconnectDialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "disconnect", buf: await disconnectDialog.screenshot() })
  await disconnectDialog.getByRole("button", { name: "Cancel" }).click()
  await disconnectDialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 6) Degraded page — red status rule + error detail.
  await page.evaluate(() =>
    (window as any).__remote.set({
      channels: [
        {
          platform: "telegram",
          state: "degraded",
          identity: { id: "8403172", name: "yuhan" },
          error: "Lost connection to Telegram",
        },
      ],
    }),
  )
  await surface.getByText("Lost connection to Telegram").first().waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "degraded", buf: await surface.screenshot() })

  const out = snapOutputPath("remote-surface")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] remote-surface grid -> ${out}\n\n`)
})
