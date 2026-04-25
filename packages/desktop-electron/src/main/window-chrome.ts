export const MACOS_SHELL_TITLEBAR_HEIGHT = 44
export const LEGACY_MACOS_TITLEBAR_HEIGHT = 40
export const LEGACY_MACOS_TRAFFIC_LIGHT_Y = 14

export function macTrafficLightPosition() {
  return {
    x: 12,
    y: LEGACY_MACOS_TRAFFIC_LIGHT_Y + (MACOS_SHELL_TITLEBAR_HEIGHT - LEGACY_MACOS_TITLEBAR_HEIGHT) / 2,
  }
}
