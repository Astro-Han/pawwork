import { describe, expect, test } from "bun:test"
import { sanitizeConfig } from "./markdown"

describe("DOMPurify whitelist config", () => {
  test("forbids unsafe tags", () => {
    expect(sanitizeConfig.FORBID_TAGS).toContain("script")
    expect(sanitizeConfig.FORBID_TAGS).toContain("iframe")
    expect(sanitizeConfig.FORBID_TAGS).toContain("style")
    expect(sanitizeConfig.FORBID_TAGS).toContain("form")
    expect(sanitizeConfig.FORBID_TAGS).toContain("input")
    expect(sanitizeConfig.FORBID_TAGS).toContain("object")
    expect(sanitizeConfig.FORBID_TAGS).toContain("embed")
  })
  test("forbids unsafe text content", () => {
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("script")
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("iframe")
    expect(sanitizeConfig.FORBID_CONTENTS).toContain("style")
  })
  test("URI regex accepts http(s) / mailto / file / relative paths", () => {
    const re = sanitizeConfig.ALLOWED_URI_REGEXP
    expect(re.test("https://example.com")).toBe(true)
    expect(re.test("http://example.com")).toBe(true)
    expect(re.test("mailto:hi@x.com")).toBe(true)
    expect(re.test("file:///tmp/x")).toBe(true)
    expect(re.test("/abs/path")).toBe(true)
    expect(re.test("./rel/path")).toBe(true)
    expect(re.test("../up/path")).toBe(true)
    expect(re.test("relative/path")).toBe(true)
    expect(re.test("#anchor")).toBe(true)
  })
  test("URI regex rejects javascript: / data: / vbscript:", () => {
    const re = sanitizeConfig.ALLOWED_URI_REGEXP
    expect(re.test("javascript:alert(1)")).toBe(false)
    expect(re.test("data:text/html,foo")).toBe(false)
    expect(re.test("vbscript:msgbox")).toBe(false)
  })
})
