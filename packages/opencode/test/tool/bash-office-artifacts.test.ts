import { describe, expect, test } from "bun:test"
import { officeCliTargets } from "../../src/tool/bash-office-artifacts"

describe("officeCliTargets", () => {
  test.each([
    ["officecli create report.docx", ["report.docx"]],
    ["officecli set report.xlsx /Sheet1/A1 --prop value=hello", ["report.xlsx"]],
    ["officecli batch report.pptx < ops.json", ["report.pptx"]],
    ['printf \'[{"command":"get","path":"/Sheet1/A1"}]\' | officecli batch report.xlsx', ["report.xlsx"]],
    ['cat ops.json | officecli batch "monthly report.xlsx"', ["monthly report.xlsx"]],
  ])("extracts static OfficeCLI target: %s", (command, expected) => {
    expect(officeCliTargets(command)).toEqual(expected)
  })

  test.each([
    "officecli view report.docx outline",
    "officecli batch readonly.officecli",
    'cat ops.json | officecli batch "$FILE"',
    "officecli batch %FILE%",
  ])("ignores non-static or read-only target: %s", (command) => {
    expect(officeCliTargets(command)).toEqual([])
  })
})
