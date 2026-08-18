export function dshWebPreferences(preload: string) {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    preload,
  }
}
