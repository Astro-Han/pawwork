import { describe, expect, test } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

import * as generateIcons from "./generate-icons"

import {
  DOCK_ICON_CONTENT_RATIO,
  ICNS_OUTPUTS,
  ICON_PNG_OUTPUTS,
  ICON_SOURCE,
  WINDOWS_TILE_OUTPUTS,
  createIcns,
  createIco,
  createPngCache,
  renderDockPng,
  resolveIconChannel,
} from "./generate-icons"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("icon generation manifest", () => {
  test("covers every icon file used by electron-builder resources", () => {
    expect(ICON_PNG_OUTPUTS).toEqual([
      { path: "32x32.png", size: 32 },
      { path: "64x64.png", size: 64 },
      { path: "128x128.png", size: 128 },
      { path: "128x128@2x.png", size: 256 },
      { path: "dock.png", size: 256 },
      { path: "icon.png", size: 1024 },
    ])

    expect(WINDOWS_TILE_OUTPUTS).toEqual([
      { path: "Square30x30Logo.png", size: 30 },
      { path: "Square44x44Logo.png", size: 44 },
      { path: "StoreLogo.png", size: 50 },
      { path: "Square71x71Logo.png", size: 71 },
      { path: "Square89x89Logo.png", size: 89 },
      { path: "Square107x107Logo.png", size: 107 },
      { path: "Square142x142Logo.png", size: 142 },
      { path: "Square150x150Logo.png", size: 150 },
      { path: "Square284x284Logo.png", size: 284 },
      { path: "Square310x310Logo.png", size: 310 },
    ])

    expect(ICNS_OUTPUTS).toEqual([
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
    ])

  })

  test("anchors source and output paths to the desktop package", () => {
    const iconDest = (generateIcons as Record<string, unknown>).ICON_DEST

    expect(ICON_SOURCE).toBe(path.join(PACKAGE_ROOT, "icons/source/icon.png"))
    expect(iconDest).toBe(path.join(PACKAGE_ROOT, "resources/icons"))
  })

  test("uses a high-resolution square source with transparency", async () => {
    const metadata = await sharp(ICON_SOURCE).metadata()

    expect(metadata.width).toBe(metadata.height)
    expect(metadata.width).toBeGreaterThanOrEqual(1024)
    expect(metadata.hasAlpha).toBe(true)
  })

  test("rejects invalid explicit channel arguments", () => {
    expect(resolveIconChannel("dev")).toBe("dev")
    expect(resolveIconChannel("beta")).toBe("beta")
    expect(resolveIconChannel("prod")).toBe("prod")
    expect(() => resolveIconChannel("staging")).toThrow("Invalid icon channel: staging")
  })

})

describe("createPngCache", () => {
  test("renders each source and size only once", async () => {
    const calls: string[] = []
    const render = createPngCache(async (source, size) => {
      calls.push(`${source}:${size}`)
      return Buffer.from(`${source}:${size}`)
    })

    await expect(render("one.svg", 16)).resolves.toEqual(Buffer.from("one.svg:16"))
    await expect(render("one.svg", 16)).resolves.toEqual(Buffer.from("one.svg:16"))
    await expect(render("one.svg", 32)).resolves.toEqual(Buffer.from("one.svg:32"))
    await expect(render("two.svg", 16)).resolves.toEqual(Buffer.from("two.svg:16"))

    expect(calls).toEqual(["one.svg:16", "one.svg:32", "two.svg:16"])
  })
})

describe("createIcns", () => {
  test("creates a valid ICNS buffer from PNG payloads", () => {
    const smallPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])
    const largePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 3])

    const icns = createIcns([
      { type: "ic04", png: smallPng },
      { type: "ic10", png: largePng },
    ])

    expect(icns.toString("ascii", 0, 4)).toBe("icns")
    expect(icns.readUInt32BE(4)).toBe(8 + 8 + smallPng.length + 8 + largePng.length)
    expect(icns.toString("ascii", 8, 12)).toBe("ic04")
    expect(icns.readUInt32BE(12)).toBe(8 + smallPng.length)
    expect(icns.subarray(16, 16 + smallPng.length)).toEqual(smallPng)
    const secondOffset = 16 + smallPng.length
    expect(icns.toString("ascii", secondOffset, secondOffset + 4)).toBe("ic10")
    expect(icns.readUInt32BE(secondOffset + 4)).toBe(8 + largePng.length)
    expect(icns.subarray(secondOffset + 8)).toEqual(largePng)
  })
})

describe("createIco", () => {
  test("creates a valid ICO buffer from PNG payloads", () => {
    const smallPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1])
    const largePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 2, 3])

    const ico = createIco([
      { size: 16, png: smallPng },
      { size: 256, png: largePng },
    ])

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(2)
    expect(ico[6]).toBe(16)
    expect(ico[22]).toBe(0)
    expect(ico.readUInt32LE(14)).toBe(smallPng.length)
    expect(ico.readUInt32LE(18)).toBe(38)
    expect(ico.readUInt32LE(30)).toBe(largePng.length)
    expect(ico.readUInt32LE(34)).toBe(38 + smallPng.length)
    expect(ico.subarray(38, 38 + smallPng.length)).toEqual(smallPng)
    expect(ico.subarray(38 + smallPng.length)).toEqual(largePng)
  })
})

describe("renderDockPng", () => {
  test("canvas size matches the requested size", async () => {
    const source = ICON_SOURCE
    const buf = await renderDockPng(source, 256)
    const { width, height } = await sharp(buf).metadata()
    expect(width).toBe(256)
    expect(height).toBe(256)
  })

  test("artwork does not fill the entire canvas (transparent padding prevents oversized Dock icon)", async () => {
    const source = ICON_SOURCE
    const canvasSize = 256
    const buf = await renderDockPng(source, canvasSize)
    // Trimming transparent edges must produce a smaller image than the full canvas.
    // A full-canvas alpha bbox here would mean no padding was applied, reproducing the bug.
    const { info } = await sharp(buf).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true })
    expect(info.width).toBeLessThan(canvasSize)
    expect(info.height).toBeLessThan(canvasSize)
  })

  test("visible artwork is approximately DOCK_ICON_CONTENT_RATIO of the canvas", async () => {
    const source = ICON_SOURCE
    const canvasSize = 256
    const buf = await renderDockPng(source, canvasSize)
    const { info } = await sharp(buf).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true })
    const expectedInner = Math.round(canvasSize * DOCK_ICON_CONTENT_RATIO)
    // Allow ±2px tolerance for antialiasing on source edges
    expect(info.width).toBeGreaterThanOrEqual(expectedInner - 2)
    expect(info.width).toBeLessThanOrEqual(expectedInner + 2)
  })
})
