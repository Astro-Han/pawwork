import { describe, expect, test } from "vitest"
import { CONSOLE_PROBE_MARKER, type ConsoleWatchEvent, assertNoVisibleConsoleWindows, startFakeToolModel } from "./ci-smoke-console-probe"

const post = (baseURL: string, body: unknown) =>
  fetch(`${baseURL}/chat/completions`, { method: "POST", body: JSON.stringify(body) }).then((response) => response.text())

describe("fake tool model", () => {
  test("asks for one pwsh call and resolves with the tool result", async () => {
    const model = await startFakeToolModel()
    try {
      expect(await post(model.baseURL, { messages: [{ role: "user", content: "title" }] })).not.toContain("tool_calls")
      const call = await post(model.baseURL, { messages: [{ role: "user", content: "go" }], tools: [{ function: { name: "pwsh" } }] })
      expect(call).toContain('"name":"pwsh"')
      expect(call).toContain('"finish_reason":"tool_calls"')
      await post(model.baseURL, { messages: [{ role: "tool", content: [{ type: "text", text: `${CONSOLE_PROBE_MARKER}\n` }] }] })
      expect(await model.toolResult).toBe(`${CONSOLE_PROBE_MARKER}\n`)
    } finally {
      await model.close()
    }
  })

  test("fails the result when the agent offers no pwsh tool", async () => {
    const model = await startFakeToolModel()
    try {
      await post(model.baseURL, { messages: [], tools: [{ function: { name: "bash" } }] })
      await expect(model.toolResult).rejects.toThrow("offered: bash")
    } finally {
      await model.close()
    }
  })
})

describe("assertNoVisibleConsoleWindows", () => {
  const shell: ConsoleWatchEvent = { kind: "process", processId: 2, name: "pwsh.exe", commandLine: "pwsh -Command pawwork-console-probe" }
  const hiddenConsole: ConsoleWatchEvent = { kind: "window", processId: 2, handle: 7, className: "ConsoleWindowClass", visible: false }

  test("accepts a console that stays hidden", () => {
    expect(() => assertNoVisibleConsoleWindows([shell, hiddenConsole], CONSOLE_PROBE_MARKER)).not.toThrow()
  })

  test("rejects a visible console window", () => {
    const shown = { ...hiddenConsole, className: "CASCADIA_HOSTING_WINDOW_CLASS", visible: true }
    expect(() => assertNoVisibleConsoleWindows([shell, shown], CONSOLE_PROBE_MARKER)).toThrow("showed console windows")
  })

  test("rejects a census that never saw the command run", () => {
    expect(() => assertNoVisibleConsoleWindows([], CONSOLE_PROBE_MARKER)).toThrow("never saw the probe's pwsh process")
    expect(() => assertNoVisibleConsoleWindows([shell], "")).toThrow("did not run the probe command")
  })
})
