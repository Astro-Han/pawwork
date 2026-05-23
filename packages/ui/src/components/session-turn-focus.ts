export function blurActiveElementInside(container: HTMLElement | undefined): boolean {
  if (!container || typeof document === "undefined") return false

  const active = document.activeElement
  const isFocusableElement =
    active instanceof HTMLElement || (typeof SVGElement !== "undefined" && active instanceof SVGElement)
  if (!isFocusableElement) return false
  if (!container.contains(active)) return false

  active.blur()
  return true
}
