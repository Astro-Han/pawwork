import { describe, expect, test } from "bun:test"
import type { UiI18n } from "../context/i18n"
import { toolIcon, toolInfoForInput } from "./tool-info"
import { BROWSER_TOOL_NAMES } from "./tool-contract"

// Echo i18n: returns the key, so a title assertion pins which i18n key a tool
// resolves to without coupling to the English copy.
const i18n: UiI18n = { locale: () => "en", t: (key) => key }

describe("browser tool info", () => {
  test("every browser tool resolves to the browser family icon", () => {
    for (const tool of BROWSER_TOOL_NAMES) expect(toolIcon(tool)).toBe("browser")
  })

  test("navigate shows the url as subtitle", () => {
    const info = toolInfoForInput("browser_navigate", { url: "https://example.com/" }, {}, i18n)
    expect(info.icon).toBe("browser")
    expect(info.title).toBe("ui.tool.browser.navigate")
    expect(info.subtitle).toBe("https://example.com/")
  })

  test("screenshot has no subtitle", () => {
    const info = toolInfoForInput("browser_screenshot", {}, {}, i18n)
    expect(info.title).toBe("ui.tool.browser.screenshot")
    expect(info.subtitle).toBeUndefined()
  })

  test("click / type / extract / wait show their selector or text target", () => {
    expect(toolInfoForInput("browser_click", { selector: "#go" }, {}, i18n).subtitle).toBe("#go")
    expect(toolInfoForInput("browser_type", { selector: "#q", text: "hi" }, {}, i18n).subtitle).toBe("#q")
    expect(toolInfoForInput("browser_extract", { selector: "main" }, {}, i18n).subtitle).toBe("main")
    expect(toolInfoForInput("browser_wait", { text: "Ready" }, {}, i18n).subtitle).toBe("Ready")
  })
})
