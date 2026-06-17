import { test } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Remote access settings page + connect flow. snap runs in web Chromium, which
// has no Electron preload, so window.api.remote is injected here as a stub to
// drive the real components and show the page as the user sees it once the
// desktop bridge is present. The IPC behaviour behind that API (pairing,
// credentials, telegram) is covered by unit tests in desktop-electron and
// remote-bridge.
test("settings-remote", async ({ page, project }) => {
  test.setTimeout(180_000)

  await page.addInitScript(() => {
    const status = { state: "disconnected", platform: null, identity: null, error: null }
    ;(window as any).api = {
      ...(window as any).api,
      remote: {
        getStatus: () => Promise.resolve(status),
        startPairing: () => Promise.resolve({ userId: "8403172", userName: "yuhan", botUsername: "my_pawwork_bot" }),
        cancelPairing: () => Promise.resolve(),
        confirmPairing: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        onStatus: () => () => {},
      },
    }
  })

  await project.open()
  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Remote access" }).click()

  // 1) Disconnected: the page shown when the bridge is present but unpaired.
  const connect = settings.getByRole("button", { name: "Connect" }).first()
  await connect.waitFor({ state: "visible", timeout: 30_000 })
  const shots: Shot[] = [{ name: "disconnected", buf: await settings.screenshot() }]

  // 2) Connect dialog, step one: paste the bot token.
  await connect.click()
  const dialog = page.getByRole("dialog")
  await dialog.waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "token", buf: await dialog.screenshot() })

  // 3) Confirm step: token accepted, the captured sender awaits approval.
  await dialog.getByRole("textbox").first().fill("8403172:AAExampleBotTokenForPreview")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await dialog.getByText("Allow this account?").waitFor({ state: "visible", timeout: 30_000 })
  shots.push({ name: "confirm", buf: await dialog.screenshot() })

  const out = snapOutputPath("settings-remote")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-remote grid -> ${out}\n\n`)
})
