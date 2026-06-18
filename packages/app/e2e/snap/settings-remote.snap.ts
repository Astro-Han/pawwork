import { test } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Remote access settings page + connect flow. snap runs in web Chromium, which has
// no Electron preload, so window.api.remote is injected here as a stub. The stub
// holds a mutable status the test drives via window.__remote.set(...), and parks
// startPairing() until window.__remote.capture(...) — so one run can snapshot every
// state the user sees: the page (disconnected / connected / degraded) and the
// connect-flow dialog (token / waiting / confirm / disconnect). The IPC behaviour
// behind that API is covered by unit tests in desktop-electron and remote-bridge.
test("settings-remote", async ({ page, project }) => {
  test.setTimeout(180_000)

  await page.addInitScript(() => {
    let status = { state: "disconnected", platform: null, identity: null, error: null } as Record<string, unknown>
    const listeners = new Set<(s: unknown) => void>()
    let resolvePairing: ((v: unknown) => void) | undefined
    ;(window as any).api = {
      ...(window as any).api,
      remote: {
        getStatus: () => Promise.resolve(status),
        // Stays pending so the dialog parks on the "waiting" step until the test
        // releases it via __remote.capture().
        startPairing: () => new Promise((resolve) => (resolvePairing = resolve)),
        cancelPairing: () => Promise.resolve(),
        confirmPairing: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        onStatus: (cb: (s: unknown) => void) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
      },
    }
    ;(window as any).__remote = {
      set: (s: Record<string, unknown>) => {
        status = s
        listeners.forEach((cb) => cb(status))
      },
      capture: (sender: unknown) => resolvePairing?.(sender),
    }
  })

  await project.open()
  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Remote access" }).click()

  const shots: Shot[] = []

  // 1) Disconnected page.
  const connect = settings.getByRole("button", { name: "Connect" }).first()
  await connect.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "disconnected", buf: await settings.screenshot() })

  // 2) Connect dialog — paste the bot token.
  await connect.click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "token", buf: await dialog.screenshot() })

  // 3) Waiting — token accepted, awaiting the first message (startPairing pending).
  await dialog.getByRole("textbox").first().fill("8403172:AAExampleBotTokenForPreview")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await dialog.getByText("Send your bot a message").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "waiting", buf: await dialog.screenshot() })

  // 4) Confirm — the captured sender awaits approval.
  await page.evaluate(() =>
    (window as any).__remote.capture({ userId: "8403172", userName: "yuhan", botUsername: "my_pawwork_bot" }),
  )
  await dialog.getByText("Allow this account?").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "confirm", buf: await dialog.screenshot() })

  // Close the connect dialog via its Close (X) control. The confirm step's Cancel
  // only steps back to the token step (it doesn't close), and the pairing flow
  // keeps Escape from tearing the dialog down — so drive the explicit X.
  await dialog.getByRole("button", { name: "Close" }).click()
  await dialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 5) Connected page — green status rule + paired identity.
  await page.evaluate(() =>
    (window as any).__remote.set({
      state: "connected",
      platform: "telegram",
      identity: { userId: "8403172", userName: "yuhan" },
      error: null,
    }),
  )
  await settings.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "connected", buf: await settings.screenshot() })

  // 6) Disconnect confirm dialog — only reachable while connected.
  await settings.getByRole("button", { name: "Disconnect" }).click()
  const disconnectDialog = page.getByRole("dialog")
  await disconnectDialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "disconnect", buf: await disconnectDialog.screenshot() })
  await disconnectDialog.getByRole("button", { name: "Cancel" }).click()
  await disconnectDialog.waitFor({ state: "hidden", timeout: 30_000 })

  // 7) Degraded page — red status rule + error detail.
  await page.evaluate(() =>
    (window as any).__remote.set({
      state: "degraded",
      platform: "telegram",
      identity: { userId: "8403172", userName: "yuhan" },
      error: "Lost connection to Telegram",
    }),
  )
  await settings.getByText("Lost connection to Telegram").first().waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "degraded", buf: await settings.screenshot() })

  const out = snapOutputPath("settings-remote")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-remote grid -> ${out}\n\n`)
})
