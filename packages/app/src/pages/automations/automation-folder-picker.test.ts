import { describe, expect, test } from "bun:test"
import { openProjectFromAutomationFolderPicker } from "./automation-folder-picker-actions"

describe("AutomationFolderPicker", () => {
  test("open-project footer closes the picker before opening a project", () => {
    const calls: Array<string | boolean> = []

    openProjectFromAutomationFolderPicker(
      (open) => calls.push(open),
      () => calls.push("open-project"),
    )

    expect(calls).toEqual([false, "open-project"])
  })
})
