import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

import * as generateIcons from "./generate-icons"

import {
  ANDROID_ICON_OUTPUTS,
  ANDROID_ICON_BACKGROUND,
  ANDROID_XML_OUTPUTS,
  ICNS_OUTPUTS,
  ICON_PNG_OUTPUTS,
  IOS_ICON_OUTPUTS,
  WINDOWS_TILE_OUTPUTS,
  createAndroidXmlFiles,
  createIcns,
  createIco,
  createPngCache,
  getIconSource,
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

    expect(ANDROID_ICON_OUTPUTS).toEqual([
      { path: "android/mipmap-mdpi/ic_launcher.png", size: 48 },
      { path: "android/mipmap-mdpi/ic_launcher_foreground.png", size: 48 },
      { path: "android/mipmap-mdpi/ic_launcher_round.png", size: 48 },
      { path: "android/mipmap-hdpi/ic_launcher.png", size: 72 },
      { path: "android/mipmap-hdpi/ic_launcher_foreground.png", size: 72 },
      { path: "android/mipmap-hdpi/ic_launcher_round.png", size: 72 },
      { path: "android/mipmap-xhdpi/ic_launcher.png", size: 96 },
      { path: "android/mipmap-xhdpi/ic_launcher_foreground.png", size: 96 },
      { path: "android/mipmap-xhdpi/ic_launcher_round.png", size: 96 },
      { path: "android/mipmap-xxhdpi/ic_launcher.png", size: 144 },
      { path: "android/mipmap-xxhdpi/ic_launcher_foreground.png", size: 144 },
      { path: "android/mipmap-xxhdpi/ic_launcher_round.png", size: 144 },
      { path: "android/mipmap-xxxhdpi/ic_launcher.png", size: 192 },
      { path: "android/mipmap-xxxhdpi/ic_launcher_foreground.png", size: 192 },
      { path: "android/mipmap-xxxhdpi/ic_launcher_round.png", size: 192 },
    ])

    expect(IOS_ICON_OUTPUTS).toEqual([
      { path: "ios/AppIcon-20x20@1x.png", size: 20 },
      { path: "ios/AppIcon-20x20@2x.png", size: 40 },
      { path: "ios/AppIcon-20x20@2x-1.png", size: 40 },
      { path: "ios/AppIcon-20x20@3x.png", size: 60 },
      { path: "ios/AppIcon-29x29@1x.png", size: 29 },
      { path: "ios/AppIcon-29x29@2x.png", size: 58 },
      { path: "ios/AppIcon-29x29@2x-1.png", size: 58 },
      { path: "ios/AppIcon-29x29@3x.png", size: 87 },
      { path: "ios/AppIcon-40x40@1x.png", size: 40 },
      { path: "ios/AppIcon-40x40@2x.png", size: 80 },
      { path: "ios/AppIcon-40x40@2x-1.png", size: 80 },
      { path: "ios/AppIcon-40x40@3x.png", size: 120 },
      { path: "ios/AppIcon-60x60@2x.png", size: 120 },
      { path: "ios/AppIcon-60x60@3x.png", size: 180 },
      { path: "ios/AppIcon-76x76@1x.png", size: 76 },
      { path: "ios/AppIcon-76x76@2x.png", size: 152 },
      { path: "ios/AppIcon-83.5x83.5@2x.png", size: 167 },
      { path: "ios/AppIcon-512@2x.png", size: 1024 },
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

    expect(ANDROID_XML_OUTPUTS).toEqual([
      "android/mipmap-anydpi-v26/ic_launcher.xml",
      "android/values/ic_launcher_background.xml",
    ])
    expect(ANDROID_ICON_BACKGROUND).toBe("#FF7C3A")
  })

  test("anchors source and output paths to the desktop package", () => {
    const iconDest = (generateIcons as Record<string, unknown>).ICON_DEST

    expect(getIconSource("dev")).toBe(path.join(PACKAGE_ROOT, "icons/source/icon.svg"))
    expect(getIconSource("beta")).toBe(path.join(PACKAGE_ROOT, "icons/source/icon.svg"))
    expect(getIconSource("prod")).toBe(path.join(PACKAGE_ROOT, "icons/source/icon.svg"))
    expect(iconDest).toBe(path.join(PACKAGE_ROOT, "resources/icons"))
  })

  test("rejects invalid explicit channel arguments", () => {
    expect(resolveIconChannel("dev")).toBe("dev")
    expect(resolveIconChannel("beta")).toBe("beta")
    expect(resolveIconChannel("prod")).toBe("prod")
    expect(() => resolveIconChannel("staging")).toThrow("Invalid icon channel: staging")
  })

  test("uses the Android XML manifest as the writer source of truth", () => {
    expect(createAndroidXmlFiles().map((file) => file.path)).toEqual(ANDROID_XML_OUTPUTS)
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
