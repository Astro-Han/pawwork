import sharp from "sharp"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type Shot = { name: string; buf: Buffer }

const CELL_GAP = 24
const LABEL_HEIGHT = 32
const LABEL_PAD_X = 12
const LABEL_FONT_SIZE = 14
const BG = { r: 248, g: 248, b: 248, alpha: 1 } as const
const LABEL_BG = "#ffffff"
const LABEL_FG = "#333333"

export function snapOutputPath(target: string): string {
  // Deterministic filename — agents and humans both want "the latest grid for
  // this target". Dated filenames accumulate clutter and force consumers to
  // resolve which file is current.
  const here = path.dirname(fileURLToPath(import.meta.url))
  // here = packages/app/e2e/snap → repoRoot four levels up
  const repoRoot = path.resolve(here, "../../../..")
  return path.join(repoRoot, "docs/design/preview/screenshots", `${target}.png`)
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case "&":
        return "&amp;"
      case "'":
        return "&apos;"
      default:
        return "&quot;"
    }
  })
}

export async function composeGrid(
  shots: Shot[],
  outputPath: string,
  options: { cols?: number } = {},
): Promise<void> {
  if (shots.length === 0) throw new Error("composeGrid: no shots")

  const cols = options.cols ?? Math.min(shots.length, 3)
  const metas = await Promise.all(
    shots.map(async (s) => {
      const meta = await sharp(s.buf).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      if (!width || !height) throw new Error(`composeGrid: ${s.name} has no dimensions`)
      return { ...s, width, height }
    }),
  )

  const rows = Math.ceil(metas.length / cols)
  // Per-column widths and per-row heights — using a single uniform max would
  // make a wide full-viewport shot blow up every cell and leave narrow shots
  // (e.g. sidebar at 320px next to sort-menu at 1440px) as tiny corners.
  const colWidths: number[] = []
  for (let c = 0; c < cols; c++) {
    let maxW = 0
    for (let r = 0; r < rows; r++) {
      const idx = r * cols + c
      if (idx < metas.length) maxW = Math.max(maxW, metas[idx].width)
    }
    colWidths.push(maxW)
  }
  const rowShotHeights: number[] = []
  for (let r = 0; r < rows; r++) {
    let maxH = 0
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c
      if (idx < metas.length) maxH = Math.max(maxH, metas[idx].height)
    }
    rowShotHeights.push(maxH)
  }
  const canvasW = colWidths.reduce((a, b) => a + b, 0) + (cols + 1) * CELL_GAP
  const canvasH = rowShotHeights.reduce((a, b) => a + b + LABEL_HEIGHT, 0) + (rows + 1) * CELL_GAP

  const colX: number[] = [CELL_GAP]
  for (let c = 0; c < cols; c++) colX.push(colX[c] + colWidths[c] + CELL_GAP)
  const rowY: number[] = [CELL_GAP]
  for (let r = 0; r < rows; r++) rowY.push(rowY[r] + rowShotHeights[r] + LABEL_HEIGHT + CELL_GAP)

  const overlays: sharp.OverlayOptions[] = []
  for (let i = 0; i < metas.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const x = colX[col]
    const y = rowY[row]
    const cellW = colWidths[col]

    overlays.push({ input: metas[i].buf, left: x, top: y })

    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${LABEL_HEIGHT}">
      <rect width="${cellW}" height="${LABEL_HEIGHT}" fill="${LABEL_BG}"/>
      <text x="${LABEL_PAD_X}" y="${LABEL_HEIGHT / 2 + LABEL_FONT_SIZE / 3}" font-family="system-ui, -apple-system, sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${LABEL_FG}">${escapeXml(metas[i].name)}</text>
    </svg>`
    overlays.push({ input: Buffer.from(labelSvg), left: x, top: y + rowShotHeights[row] })
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: BG },
  })
    .composite(overlays)
    .png()
    .toFile(outputPath)
}
