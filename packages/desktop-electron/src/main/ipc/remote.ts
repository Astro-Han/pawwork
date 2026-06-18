import { BrowserWindow, ipcMain } from "electron"
import type { RemotePairingStart, RemotePlatform } from "@opencode-ai/app/desktop-api"
import type { RemoteBridgeRuntime } from "../remote-bridge"

/**
 * Wires the mobile-companion bridge IPC. Secrets stay main-only: the Telegram token
 * crosses once, inbound, inside the start-pairing options; Feishu/WeChat are QR
 * flows that mint credentials main-side. confirm/disconnect carry no secret, and
 * the status read back is always masked. Status and pairing progress are broadcast
 * to every window so the page reflects connect/degraded and the QR → bind → captured
 * steps without polling.
 */
export function registerRemoteIpc(runtime: RemoteBridgeRuntime) {
  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
  runtime.onStatusChange((status) => broadcast("remote:status", status))
  runtime.onPairing((event) => broadcast("remote:pairing", event))

  ipcMain.handle("remote:get-status", () => runtime.getStatus())
  // Fire-and-forget: the QR, the bind hint, and the outcome (captured / error /
  // cancelled) all arrive on remote:pairing, so this just kicks the flow off.
  ipcMain.handle("remote:start-pairing", (_event, platform: RemotePlatform, start?: RemotePairingStart) =>
    runtime.startPairing(platform, start),
  )
  ipcMain.handle("remote:cancel-pairing", () => runtime.cancelPairing())
  // No secret: the credential + captured identity are held main-side from
  // start-pairing, so confirm only approves them for the named platform.
  ipcMain.handle("remote:confirm-pairing", (_event, platform: RemotePlatform) => runtime.confirmPairing(platform))
  ipcMain.handle("remote:disconnect", (_event, platform: RemotePlatform) => runtime.disconnect(platform))
}
