import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import sharp from "sharp"

import { createConfig } from "../electron-builder.config"

import * as generateIcons from "./generate-icons"

import {
  DOCK_ICON_CONTENT_RATIO,
  ICON_PNG_OUTPUTS,
  GENERATED_ICON_FILES,
  ICON_SOURCE,
  createIcns,
  createIco,
  createPngCache,
  renderDockPng,
} from "./generate-icons"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

describe("icon generation manifest", () => {
  // Comparing the manifest against itself proved nothing. The manifest matters
  // because two other places name these files: electron-builder ships and points
  // at them, and the main process loads the Dock icon out of what was shipped.
  test("generates every icon file electron-builder names", () => {
    const config = createConfig("prod") as unknown

    const named = new Set<string>()
    const visit = (value: unknown, underIconResources = false) => {
      if (typeof value === "string") {
        const match = /resources\/icons\/(.+)$/.exec(value)
        if (match) named.add(match[1])
        else if (underIconResources) named.add(value)
        return
      }
      if (Array.isArray(value)) return value.forEach((entry) => visit(entry, underIconResources))
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        const icons = underIconResources || String(record.from ?? "").includes("resources/icons")
        for (const [key, entry] of Object.entries(record)) visit(entry, icons && key === "filter")
      }
    }
    visit(config)

    expect(named.size).toBeGreaterThan(0)
    expect([...named].filter((file) => !GENERATED_ICON_FILES.includes(file)).sort()).toEqual([])
  })

  // The Dock icon is loaded by name at runtime rather than named in the config.
  test("generates the Dock icon the main process loads", () => {
    const windows = readFileSync(path.join(PACKAGE_ROOT, "src/main/windows.ts"), "utf8")
    const loaded = [...windows.matchAll(/iconsDir\(\), "([^"]+)"\)/g)].map((match) => match[1])

    expect(loaded).not.toEqual([])
    expect(loaded.filter((file) => !GENERATED_ICON_FILES.includes(file))).toEqual([])
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
