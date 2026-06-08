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
    // No `//`, so host:port is a host (not a scheme) and gets a scheme prefixed.
    expect(normalizeAddressInput("192.168.0.1:8080/p?q=1")).toBe("https://192.168.0.1:8080/p?q=1")
  })

  test("defaults loopback hosts to http so local dev servers just work", () => {
    expect(normalizeAddressInput("localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeAddressInput("127.0.0.1:8080/p?q=1")).toBe("http://127.0.0.1:8080/p?q=1")
    expect(normalizeAddressInput("api.localhost")).toBe("http://api.localhost")
    expect(normalizeAddressInput("[::1]:5173")).toBe("http://[::1]:5173")
    expect(normalizeAddressInput("0.0.0.0:5173")).toBe("http://0.0.0.0:5173")
  })

  test("keeps https for non-loopback hosts, including private LAN IPs", () => {
    // Private LAN may sit on a hostile shared network, so a bare host keeps the
    // https default; the user can type http:// to opt into plaintext.
    expect(normalizeAddressInput("192.168.0.1:8080")).toBe("https://192.168.0.1:8080")
    expect(normalizeAddressInput("10.0.0.5:3000")).toBe("https://10.0.0.5:3000")
    expect(normalizeAddressInput("myserver:8080")).toBe("https://myserver:8080")
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
