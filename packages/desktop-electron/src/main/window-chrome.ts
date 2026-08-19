export function macTrafficLightPosition() {
  return { x: 12, y: 16 }
}

const DSH_TITLE = "DeepSeek Harness"

export function pawworkWindowTitle(pageTitle: string) {
  if (pageTitle === DSH_TITLE) return "PawWork"
  const suffix = ` — ${DSH_TITLE}`
  return pageTitle.endsWith(suffix) ? `${pageTitle.slice(0, -suffix.length)} — PawWork` : pageTitle
}
