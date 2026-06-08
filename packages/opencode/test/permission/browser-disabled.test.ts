import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

// The six browser tools gate on the shared `browser` permission key, so the
// model-facing tool list (filtered via Permission.disabled) must hide all of
// them on a wildcard `browser: deny` — otherwise the model keeps calling tools
// that are guaranteed to fail at execution.
const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_screenshot",
  "browser_extract",
  "browser_wait",
  "browser_click",
  "browser_type",
]

describe("Permission.disabled browser mapping", () => {
  test("a wildcard browser deny hides every browser tool", () => {
    const rules = Permission.fromConfig({ browser: "deny" })
    const disabled = Permission.disabled(BROWSER_TOOLS, rules)
    for (const tool of BROWSER_TOOLS) expect(disabled.has(tool)).toBe(true)
  })

  test("a browser allow leaves them enabled", () => {
    const rules = Permission.fromConfig({ browser: "allow" })
    expect(Permission.disabled(BROWSER_TOOLS, rules).size).toBe(0)
  })

  test("a pattern-scoped browser deny does not hide them", () => {
    // Hide only fires on a wildcard deny; a scoped deny still surfaces the tool
    // so the model can call it on the targets that remain allowed.
    const rules = Permission.fromConfig({ browser: { "https://blocked.example/*": "deny" } })
    expect(Permission.disabled(BROWSER_TOOLS, rules).size).toBe(0)
  })
})
