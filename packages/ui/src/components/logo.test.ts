import { describe, expect, test } from "bun:test"

const logoSource = await Bun.file(new URL("./logo.tsx", import.meta.url)).text()

const canonicalToeCoordinates = ['cx="24.8"', 'cx="39.2"', 'cx="18.3"', 'cx="45.75"']
const canonicalPadPath =
  "M32 29.2 C24.2 29.2 19.8 37.6 19.8 42.6 C19.8 46.4 23.3 47.9 28.3 46.1 C30.1 45.4 33.9 45.4 35.8 46.1 C40.8 47.9 44.2 46.4 44.2 42.6 C44.2 37.6 39.8 29.2 32 29.2 Z"

describe("PawWork logo geometry", () => {
  test("logo components use the canonical four-toe paw mark", () => {
    expect(logoSource.match(/<circle\b/g)?.length).toBe(4)
    expect(logoSource.match(/viewBox="0 0 64 64"/g)?.length).toBe(3)
    for (const coordinate of canonicalToeCoordinates) {
      expect(logoSource).toContain(coordinate)
    }
    expect(logoSource).toContain(canonicalPadPath)
    expect(logoSource).not.toContain('cx="50"')
    expect(logoSource).not.toContain('ry="13"')
  })
})
