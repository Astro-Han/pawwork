import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

type IconOutput = {
  path: string
  size: number
}

type IcoImage = {
  size: number
  png: Buffer
}

type IcnsImage = {
  type: string
  png: Buffer
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const ICON_DEST = path.join(PACKAGE_ROOT, "resources/icons")
export const ICON_SOURCE = path.join(PACKAGE_ROOT, "icons/source/icon.png")

export const ICON_PNG_OUTPUTS: IconOutput[] = [
  { path: "dock.png", size: 256 },
  { path: "icon.png", size: 1024 },
]

export const ICNS_OUTPUTS = [
  { type: "ic04", size: 16 },
  { type: "ic11", size: 32 },
  { type: "ic05", size: 32 },
  { type: "ic12", size: 64 },
  { type: "ic07", size: 128 },
  { type: "ic13", size: 256 },
  { type: "ic08", size: 256 },
  { type: "ic14", size: 512 },
  { type: "ic09", size: 512 },
  { type: "ic10", size: 1024 },
]

const ICO_OUTPUTS = [16, 24, 32, 48, 64, 256]

const ICO_FILE = "icon.ico"
const ICNS_FILE = "icon.icns"

// electron-builder and the main process load these by name from a directory this
// script wipes on every run, so a name only they know would ship as a blank icon.
export const GENERATED_ICON_FILES = [...ICON_PNG_OUTPUTS.map((output) => output.path), ICO_FILE, ICNS_FILE]

export function createPngCache(render: (source: string, size: number) => Promise<Buffer>) {
  const cache = new Map<string, Promise<Buffer>>()

  return (source: string, size: number) => {
    const key = `${source}\0${size}`
    const cached = cache.get(key)
    if (cached) return cached
    const rendered = render(source, size)
    cache.set(key, rendered)
    return rendered
  }
}

export function createIco(images: IcoImage[]) {
  const headerSize = 6
  const entrySize = 16
  const directorySize = headerSize + images.length * entrySize
  const totalSize = directorySize + images.reduce((sum, image) => sum + image.png.length, 0)
  const ico = Buffer.alloc(totalSize)

  ico.writeUInt16LE(0, 0)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(images.length, 4)

  let imageOffset = directorySize
  images.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize
    const size = image.size >= 256 ? 0 : image.size

    ico[entryOffset] = size
    ico[entryOffset + 1] = size
    ico[entryOffset + 2] = 0
    ico[entryOffset + 3] = 0
    ico.writeUInt16LE(1, entryOffset + 4)
    ico.writeUInt16LE(32, entryOffset + 6)
    ico.writeUInt32LE(image.png.length, entryOffset + 8)
    ico.writeUInt32LE(imageOffset, entryOffset + 12)
    image.png.copy(ico, imageOffset)
    imageOffset += image.png.length
  })

  return ico
}

export function createIcns(images: IcnsImage[]) {
  const totalSize = 8 + images.reduce((sum, image) => sum + 8 + image.png.length, 0)
  const icns = Buffer.alloc(totalSize)

  icns.write("icns", 0, "ascii")
  icns.writeUInt32BE(totalSize, 4)

  let imageOffset = 8
  images.forEach((image) => {
    icns.write(image.type, imageOffset, "ascii")
    icns.writeUInt32BE(8 + image.png.length, imageOffset + 4)
    image.png.copy(icns, imageOffset + 8)
    imageOffset += 8 + image.png.length
  })

  return icns
}

const renderPng = createPngCache((source, size) => sharp(source).resize(size, size).png().toBuffer())

async function writePng(source: string, output: IconOutput) {
  const target = path.join(ICON_DEST, output.path)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, await renderPng(source, output.size))
}

/**
 * Fraction of the canvas that the visible artwork occupies in dock.png.
 * macOS masks Dock icons with ~80% coverage; a full-canvas PNG appears oversized.
 */
export const DOCK_ICON_CONTENT_RATIO = 0.8

/**
 * Render a Dock-safe PNG: the icon artwork is scaled to
 * `canvasSize * DOCK_ICON_CONTENT_RATIO` and centred on a transparent canvas.
 * This prevents the macOS Dock from rendering the icon larger than its neighbours.
 */
export async function renderDockPng(source: string, canvasSize: number): Promise<Buffer> {
  const inner = Math.round(canvasSize * DOCK_ICON_CONTENT_RATIO)
  const padStart = Math.floor((canvasSize - inner) / 2)
  const padEnd = canvasSize - inner - padStart
  return sharp(source)
    .resize(inner, inner)
    .extend({
      top: padStart,
      bottom: padEnd,
      left: padStart,
      right: padEnd,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
}

async function writeDockPng(source: string, output: IconOutput) {
  const target = path.join(ICON_DEST, output.path)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, await renderDockPng(source, output.size))
}

async function writeIcns(source: string) {
  const images = await Promise.all(
    ICNS_OUTPUTS.map(async (output) => ({
      type: output.type,
      png: await renderPng(source, output.size),
    })),
  )
  await writeFile(path.join(ICON_DEST, ICNS_FILE), createIcns(images))
}

async function writeIco(source: string) {
  const images = await Promise.all(
    ICO_OUTPUTS.map(async (size) => ({
      size,
      png: await renderPng(source, size),
    })),
  )
  await writeFile(path.join(ICON_DEST, ICO_FILE), createIco(images))
}

async function generate() {
  const source = ICON_SOURCE
  // dock.png requires transparent padding (see renderDockPng); exclude from the batch path.
  const outputs = ICON_PNG_OUTPUTS.filter((output) => output.path !== "dock.png")
  const dockOutput = ICON_PNG_OUTPUTS.find((o) => o.path === "dock.png")!

  await rm(ICON_DEST, { recursive: true, force: true })
  await mkdir(ICON_DEST, { recursive: true })
  await Promise.all([...outputs.map((output) => writePng(source, output)), writeDockPng(source, dockOutput)])
  await writeIco(source)
  await writeIcns(source)

  console.log(`Generated icons from ${source} into ${ICON_DEST}`)
}

if (import.meta.main) await generate()
