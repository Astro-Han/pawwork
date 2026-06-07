import { describe, expect, test } from "bun:test"
import { formatAddress, normalizeAddressInput } from "./url"

describe("normalizeAddressInput", () => {
  test("returns null for empty / whitespace-only input", () => {
    expect(normalizeAddressInput("")).toBeNull()
    expect(normalizeAddressInput("   ")).toBeNull()
  })

  test("prefixes https:// for bare hosts and trims", () => {
    expect(normalizeAddressInput("example.com")).toBe("https://example.com")
    expect(normalizeAddressInput("  example.com/docs  ")).toBe("https://example.com/docs")
  })

  test("passes through explicit http/https schemes unchanged (case-insensitive)", () => {
    expect(normalizeAddressInput("https://a.com/x?q=1")).toBe("https://a.com/x?q=1")
    expect(normalizeAddressInput("http://a.com")).toBe("http://a.com")
    expect(normalizeAddressInput("HTTPS://A.com")).toBe("HTTPS://A.com")
  })

  test("treats host:port as a host, not a scheme", () => {
    expect(normalizeAddressInput("localhost:3000")).toBe("https://localhost:3000")
    expect(normalizeAddressInput("192.168.0.1:8080/p?q=1")).toBe("https://192.168.0.1:8080/p?q=1")
  })

  test("passes through other schemes for the main process to validate/reject", () => {
    expect(normalizeAddressInput("ftp://files.example.com")).toBe("ftp://files.example.com")
  })
})

describe("formatAddress", () => {
  test("splits host and path, strips www and a lone slash", () => {
    expect(formatAddress("https://www.lumen.so/feed")).toEqual({ host: "lumen.so", path: "/feed" })
    expect(formatAddress("https://lumen.so/")).toEqual({ host: "lumen.so", path: "" })
    expect(formatAddress("https://lumen.so/a?b=1#c")).toEqual({ host: "lumen.so", path: "/a?b=1#c" })
  })

  test("falls back to the raw string when it does not parse", () => {
    expect(formatAddress("not a url")).toEqual({ host: "not a url", path: "" })
  })
})
