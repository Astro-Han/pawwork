import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// A tiny placeholder QR so the <img> slot renders in the snapshot — the real QR is
// generated main-side (Node qrcode), and web Chromium has no bridge to mint one.
const QR_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='white'/>" +
      "<g fill='black'><rect x='12' y='12' width='52' height='52'/><rect x='136' y='12' width='52' height='52'/>" +
      "<rect x='12' y='136' width='52' height='52'/><rect x='24' y='24' width='28' height='28' fill='white'/>" +
      "<rect x='148' y='24' width='28' height='28' fill='white'/><rect x='24' y='148' width='28' height='28' fill='white'/>" +
      "<rect x='84' y='84' width='32' height='32'/><rect x='148' y='148' width='16' height='16'/></g></svg>",
  )

// Remote control surface + connect flow. snap runs in web Chromium, which has no
// Electron preload, so window.api.remote is injected here as a stub: a mutable
// per-channel status the test drives via __remote.set(...), and a pairing-event
// emitter (__remote.emit) that walks the connect dialog through qr -> bind ->
// captured. One run snapshots every state the user sees — the page
// (disconnected / connected / degraded) and the connect dialog (Telegram token +
// message bind, Feishu QR + group bind, captured confirm, disconnect). The IPC
// behind that API is covered by desktop-electron + remote-bridge unit tests.
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

  // 1) Disconnected page — all three channels offer Connect.
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

  // 4) Feishu — QR step, then the group bind.
  await surface.locator('[data-action="remote-connect-feishu"]').click()
  dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  await page.evaluate(
    (image) => (window as any).__remote.emit({ phase: "qr", platform: "feishu", image, code: "B9VZ-RT8J" }),
    QR_PLACEHOLDER,
  )
  await dialog.locator("img").first().waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "feishu-qr", buf: await dialog.screenshot() })
  await page.evaluate(() => (window as any).__remote.emit({ phase: "awaitingBind", platform: "feishu", hint: "group" }))
  await dialog.getByText("Add the bot to a group").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "feishu-bind", buf: await dialog.screenshot() })
  await dialog.getByRole("button", { name: "Close" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 5) Connected page — Telegram green + paired identity, others still offer Connect.
  await page.evaluate(() =>
    (window as any).__remote.set({
      channels: [{ platform: "telegram", state: "connected", identity: { id: "8403172", name: "yuhan" }, error: null }],
    }),
  )
  await surface.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "connected", buf: await surface.screenshot() })

  // 6) Disconnect confirm — only reachable while connected.
  await surface.locator('[data-action="remote-disconnect-telegram"]').click()
  const disconnectDialog = page.getByRole("dialog")
  await disconnectDialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "disconnect", buf: await disconnectDialog.screenshot() })
  await disconnectDialog.getByRole("button", { name: "Cancel" }).click()
  await disconnectDialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 7) Degraded page — red status rule + error detail.
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
