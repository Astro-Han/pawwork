import { describe, expect, test } from "bun:test"
import { chromeMajorVersion, configurePartitionUserAgent, toChromeUserAgent } from "./user-agent"

// Real Electron 40.8.0 UA shapes (Chromium 144). The app product token is
// "PawWork Dev/<ver>" by default and "opencode/<ver>" after index.ts's rewrite —
// both must be stripped.
const MAC_ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PawWork Dev/2026.6.7 Chrome/144.0.7559.236 Electron/40.8.0 Safari/537.36"
const MAC_ELECTRON_REWRITTEN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) opencode/2026.6.7 Chrome/144.0.7559.236 Electron/40.8.0 Safari/537.36"
const WIN_ELECTRON =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) opencode/2026.6.7 Chrome/144.0.7559.236 Electron/40.8.0 Safari/537.36"

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
const WIN_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"

describe("toChromeUserAgent", () => {
  test("strips Electron + spaced app token and pins the reduced Chrome version (macOS)", () => {
    expect(toChromeUserAgent(MAC_ELECTRON, "144.0.7559.236")).toBe(MAC_CHROME)
  })

  test("handles the index.ts-rewritten opencode token", () => {
    expect(toChromeUserAgent(MAC_ELECTRON_REWRITTEN, "144.0.7559.236")).toBe(MAC_CHROME)
  })

  test("preserves the Windows platform token", () => {
    expect(toChromeUserAgent(WIN_ELECTRON, "144.0.7559.236")).toBe(WIN_CHROME)
  })

  test("leaves no Electron / opencode / PawWork token or double space behind", () => {
    const ua = toChromeUserAgent(MAC_ELECTRON, "144.0.7559.236")
    expect(ua).not.toContain("Electron")
    expect(ua).not.toContain("opencode")
    expect(ua).not.toContain("PawWork")
    expect(ua).not.toMatch(/ {2,}/)
  })

  test("is idempotent on an already-clean Chrome UA", () => {
    expect(toChromeUserAgent(MAC_CHROME, "144.0.7559.236")).toBe(MAC_CHROME)
  })

  test("accepts a major-only version", () => {
    expect(toChromeUserAgent(MAC_ELECTRON, "144")).toContain("Chrome/144.0.0.0")
  })

  test("leaves the Chrome token alone when the version is unparseable", () => {
    expect(toChromeUserAgent(MAC_ELECTRON, "unknown")).toContain("Chrome/144.0.7559.236")
  })
})

describe("configurePartitionUserAgent", () => {
  test("sets the cleaned Chrome UA on the partition session (no Electron/app token)", () => {
    let applied: string | undefined
    const sess = {
      getUserAgent: () => MAC_ELECTRON,
      setUserAgent: (ua: string) => {
        applied = ua
      },
    }
    configurePartitionUserAgent(sess, "144.0.7559.236")
    // The seam must hand the partition the cleaned UA — this is what is in place
    // before the controller creates the first view.
    expect(applied).toBe(MAC_CHROME)
    expect(applied).not.toContain("Electron")
  })
})

describe("chromeMajorVersion", () => {
  test("extracts the major", () => {
    expect(chromeMajorVersion("144.0.7559.236")).toBe("144")
    expect(chromeMajorVersion("144")).toBe("144")
  })

  test("returns null for a non-numeric version", () => {
    expect(chromeMajorVersion("unknown")).toBeNull()
    expect(chromeMajorVersion("")).toBeNull()
  })
})
