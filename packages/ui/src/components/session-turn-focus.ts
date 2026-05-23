export function blurActiveElementInside(container: HTMLElement | undefined): boolean {
  if (!container || typeof document === "undefined") return false

  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (!container.contains(active)) return false

  active.blur()
  return true
}
