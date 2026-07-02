export function normalizedSidebarWidth(input: { width: number; minWidth: number; maxWidth: number }) {
  const min = Number.isFinite(input.minWidth) ? input.minWidth : 0
  const max = Number.isFinite(input.maxWidth) ? Math.max(input.maxWidth, min) : min
  const width = Number.isFinite(input.width) ? input.width : min
  return Math.min(Math.max(width, min), max)
}
