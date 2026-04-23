import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"

const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8")
const errorPage = readFileSync(new URL("./error.tsx", import.meta.url), "utf8")
const settings = readFileSync(new URL("../components/settings-general.tsx", import.meta.url), "utf8")
const platform = readFileSync(new URL("../context/platform.tsx", import.meta.url), "utf8")

describe("update install renderer contracts", () => {
  test("renderer install actions do not relaunch after platform update", () => {
    expect(layout).not.toMatch(/await\s+platform\.restart!\(\)/)
    expect(settings).not.toMatch(/await\s+platform\.restart!\(\)/)
    expect(errorPage).not.toMatch(/await\s+platform\.restart!\(\)/)
    expect(layout).not.toMatch(/\.then\(\(\)\s*=>\s*platform\.restart!\(\)\)/)
    expect(settings).not.toMatch(/\.then\(\(\)\s*=>\s*platform\.restart!\(\)\)/)
    expect(errorPage).not.toMatch(/\.then\(\(\)\s*=>\s*platform\.restart!\(\)\)/)
  })

  test("renderer update prompts only require platform update", () => {
    expect(layout).toContain("if (!platform.checkUpdate || !platform.update) return")
    expect(layout).not.toContain("if (!platform.checkUpdate || !platform.update || !platform.restart) return")
    expect(settings).toContain("platform.update")
    expect(settings).not.toContain("platform.update && platform.restart")
  })

  test("cache update failures are part of the renderer-facing type", () => {
    expect(platform).toContain('"check" | "download" | "metadata" | "cache"')
  })
})
