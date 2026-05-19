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
  const date = new Date().toISOString().slice(0, 10)
  const here = path.dirname(fileURLToPath(import.meta.url))
  // here = packages/app/e2e/snap → repoRoot four levels up
  const repoRoot = path.resolve(here, "../../../..")
  return path.join(repoRoot, "docs/design/preview/screenshots", `${target}-${date}.png`)
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

  const cellW = Math.max(...metas.map((m) => m.width))
  const cellH = Math.max(...metas.map((m) => m.height))
  const rows = Math.ceil(metas.length / cols)
  const canvasW = cols * cellW + (cols + 1) * CELL_GAP
  const canvasH = rows * (cellH + LABEL_HEIGHT) + (rows + 1) * CELL_GAP

  const overlays: sharp.OverlayOptions[] = []
  for (let i = 0; i < metas.length; i++) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const x = CELL_GAP + col * (cellW + CELL_GAP)
    const y = CELL_GAP + row * (cellH + LABEL_HEIGHT + CELL_GAP)

    overlays.push({ input: metas[i].buf, left: x, top: y })

    const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${LABEL_HEIGHT}">
      <rect width="${cellW}" height="${LABEL_HEIGHT}" fill="${LABEL_BG}"/>
      <text x="${LABEL_PAD_X}" y="${LABEL_HEIGHT / 2 + LABEL_FONT_SIZE / 3}" font-family="system-ui, -apple-system, sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${LABEL_FG}">${escapeXml(metas[i].name)}</text>
    </svg>`
    overlays.push({ input: Buffer.from(labelSvg), left: x, top: y + cellH })
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: BG },
  })
    .composite(overlays)
    .png()
    .toFile(outputPath)
}
