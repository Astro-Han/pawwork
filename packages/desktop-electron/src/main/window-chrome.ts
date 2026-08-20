// A frameless window paints the native window controls into the content's own
// coordinate space: traffic lights top-left on macOS, the overlay buttons
// top-right on Windows. The web content has to keep that band clear, and the
// band is also the window's only drag region — without it the renderer declares
// no -webkit-app-region at all and the window cannot be moved except by its
// edges.
//
// Windows publishes the real geometry to CSS itself through
// env(titlebar-area-*), so the renderer reads it there and gets fullscreen and
// DPI handling for free. macOS has no equivalent: titleBarOverlay is ignored
// there (navigator.windowControlsOverlay stays invisible and the env variables
// resolve to 0px), and we position the traffic lights ourselves anyway — so
// macOS is the one platform whose number we own and must publish.
export const TITLEBAR_HEIGHT = 32
const TRAFFIC_LIGHT_DIAMETER = 12

export function macTrafficLightPosition() {
  return { x: 12, y: Math.round((TITLEBAR_HEIGHT - TRAFFIC_LIGHT_DIAMETER) / 2) }
}

// Fullscreen hides the traffic lights, so the band must collapse with them or
// the app keeps a dead strip and a drag region that swallows clicks.
export function titlebarInsetCss(platform: NodeJS.Platform, options: { fullscreen: boolean }) {
  if (platform !== "darwin" || options.fullscreen) return ""
  return `:root { --pawwork-titlebar-host-height: ${TITLEBAR_HEIGHT}px; }`
}

const DSH_TITLE = "DeepSeek Harness"

export function pawworkWindowTitle(pageTitle: string) {
  if (pageTitle === DSH_TITLE) return "PawWork"
  const suffix = ` — ${DSH_TITLE}`
  return pageTitle.endsWith(suffix) ? `${pageTitle.slice(0, -suffix.length)} — PawWork` : pageTitle
}
