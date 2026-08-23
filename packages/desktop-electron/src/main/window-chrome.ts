// A frameless window paints the native window controls into the content's own
// coordinate space: traffic lights top-left on macOS, the overlay buttons
// top-right on Windows. Only those corners need layout space; a transparent
// renderer strip supplies the drag region without pushing all content down.
//
// Windows publishes the real geometry to CSS itself through
// env(titlebar-area-*), so the renderer reads it there and gets fullscreen and
// DPI handling for free. macOS has no equivalent: titleBarOverlay is ignored
// there and the env variables are unset, and we position the traffic lights
// ourselves anyway — so macOS is the one platform whose geometry we publish.
export const TITLEBAR_HEIGHT = 32
const TRAFFIC_LIGHT_DIAMETER = 12
const MAC_TRAFFIC_LIGHT_TOP = 12
const MAC_CONTROL_CENTER = MAC_TRAFFIC_LIGHT_TOP + TRAFFIC_LIGHT_DIAMETER / 2
// Measured from the window edge through the trailing edge of the native cluster.
const MAC_TRAFFIC_LIGHT_INSET = 72

export function macTrafficLightPosition() {
  return { x: 12, y: MAC_TRAFFIC_LIGHT_TOP }
}

// Fullscreen hides the traffic lights, so both their corner inset and the drag
// strip height collapse with them.
export function titlebarInsetCss(platform: NodeJS.Platform, options: { fullscreen: boolean }) {
  if (platform !== "darwin" || options.fullscreen) return ""
  return `:root { --pawwork-titlebar-host-height: ${TITLEBAR_HEIGHT}px; --pawwork-titlebar-host-inset-left: ${MAC_TRAFFIC_LIGHT_INSET}px; --pawwork-titlebar-host-control-center-y: ${MAC_CONTROL_CENTER}px; }`
}

const DSH_TITLE = "DeepSeek Harness"

export function pawworkWindowTitle(pageTitle: string) {
  if (pageTitle === DSH_TITLE) return "PawWork"
  const suffix = ` — ${DSH_TITLE}`
  return pageTitle.endsWith(suffix) ? `${pageTitle.slice(0, -suffix.length)} — PawWork` : pageTitle
}
