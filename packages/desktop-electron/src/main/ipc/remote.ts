import { BrowserWindow, ipcMain } from "electron"
import { PairingCancelledError, type RemoteBridgeRuntime } from "../remote-bridge"

/**
 * Wires the mobile-companion bridge IPC. The renderer can only connect, pair,
 * disconnect, and read masked status — the bot token stays main-only and never
 * crosses a remote:* channel. Status changes are broadcast to every window so
 * the settings page reflects connect/degraded without polling.
 */
export function registerRemoteIpc(runtime: RemoteBridgeRuntime) {
  runtime.onStatusChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("remote:status", status)
    }
  })

  ipcMain.handle("remote:get-status", () => runtime.getStatus())
  // Resolves with the captured sender, or null if the user cancelled (closed the
  // connect dialog). A real failure (bad token) rejects so the UI can show it.
  ipcMain.handle("remote:start-pairing", async (_event, token: string) => {
    try {
      return await runtime.startPairing(token)
    } catch (err) {
      if (err instanceof PairingCancelledError) return null
      throw err
    }
  })
  ipcMain.handle("remote:cancel-pairing", () => runtime.cancelPairing())
  // No args: the token + captured identity are held main-side from start-pairing,
  // so confirm only approves them — the renderer can't supply or swap the token.
  ipcMain.handle("remote:confirm-pairing", () => runtime.confirmPairing())
  ipcMain.handle("remote:disconnect", () => runtime.disconnect())
}
