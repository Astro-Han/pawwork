// A frameless window paints the native window controls into the content's own
// coordinate space: traffic lights top-left on macOS, the overlay buttons
// top-right on Windows. This strip is the band they own, kept out of the web
// viewport, and it is also the window's only drag region — before it existed
// the renderer declared no -webkit-app-region at all, so the window could not
// be moved except by its edges.
//
// The height is declared here once. The main process places the native controls
// with it, and publishes it to the renderer as a CSS variable so the web
// content can inset itself by the same number.
export const TITLEBAR_HEIGHT = 32
const TRAFFIC_LIGHT_DIAMETER = 12

export function macTrafficLightPosition() {
  return { x: 12, y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2) }
}

// Linux keeps the system title bar, so nothing overlaps the content there.
export function titlebarHeight(platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32" ? TITLEBAR_HEIGHT : 0
}

// Where the height stops being a main-process number and becomes one the web
// content can read. Linux publishes nothing and the renderer falls back to 0px.
export function titlebarInsetCss(platform: NodeJS.Platform) {
  const height = titlebarHeight(platform)
  return height === 0 ? "" : `:root { --pawwork-titlebar-height: ${height}px; }`
}

const DSH_TITLE = "DeepSeek Harness"

export function pawworkWindowTitle(pageTitle: string) {
  if (pageTitle === DSH_TITLE) return "PawWork"
  const suffix = ` — ${DSH_TITLE}`
  return pageTitle.endsWith(suffix) ? `${pageTitle.slice(0, -suffix.length)} — PawWork` : pageTitle
}
