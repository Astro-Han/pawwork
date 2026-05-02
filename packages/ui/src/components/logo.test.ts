import { describe, expect, test } from "bun:test"

const logoSource = await Bun.file(new URL("./logo.tsx", import.meta.url)).text()
const logoCssSource = await Bun.file(new URL("./logo.css", import.meta.url)).text()

const canonicalToePatterns = [
  /<circle\b(?=[^>]*\bcx="24\.8")(?=[^>]*\bcy="22")(?=[^>]*\br="4\.4")[^>]*\/>/,
  /<circle\b(?=[^>]*\bcx="39\.2")(?=[^>]*\bcy="22")(?=[^>]*\br="4\.4")[^>]*\/>/,
  /<circle\b(?=[^>]*\bcx="18\.3")(?=[^>]*\bcy="30\.75")(?=[^>]*\br="3\.8")[^>]*\/>/,
  /<circle\b(?=[^>]*\bcx="45\.75")(?=[^>]*\bcy="30\.75")(?=[^>]*\br="3\.8")[^>]*\/>/,
]
const canonicalPadPattern =
  /<path\b(?=[^>]*\bd="M32\s+29\.2\s+C24\.2\s+29\.2\s+19\.8\s+37\.6\s+19\.8\s+42\.6\s+C19\.8\s+46\.4\s+23\.3\s+47\.9\s+28\.3\s+46\.1\s+C30\.1\s+45\.4\s+33\.9\s+45\.4\s+35\.8\s+46\.1\s+C40\.8\s+47\.9\s+44\.2\s+46\.4\s+44\.2\s+42\.6\s+C44\.2\s+37\.6\s+39\.8\s+29\.2\s+32\s+29\.2\s+Z")[^>]*\/>/

describe("PawWork logo geometry", () => {
  test("logo components use the canonical four-toe paw mark", () => {
    expect(logoSource.match(/<circle\b/g)?.length).toBe(4)
    expect(logoSource.match(/<svg\b(?=[^>]*\bviewBox="0 0 64 64")[^>]*>/g)?.length).toBe(3)
    for (const pattern of canonicalToePatterns) {
      expect(logoSource).toMatch(pattern)
    }
    expect(logoSource).toMatch(canonicalPadPattern)
    expect(logoSource).toMatch(/data-component="logo"/)
    expect(logoCssSource).toMatch(/\[data-component="logo-mark"\]\s*{[^}]*aspect-ratio:\s*1\/1;/)
    expect(logoSource).not.toMatch(/cx=["']50["'][^>]*ry=["']13["']/)
  })
})
