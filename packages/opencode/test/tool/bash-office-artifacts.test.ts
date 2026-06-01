import { describe, expect, test } from "bun:test"
import { nonOfficeCliCommandText, officeCliTargets } from "../../src/tool/bash-office-artifacts"

describe("officeCliTargets", () => {
  test.each([
    ["officecli create report.docx", ["report.docx"]],
    ["officecli.exe create report.docx", ["report.docx"]],
    ["officecli set report.xlsx /Sheet1/A1 --prop value=hello", ["report.xlsx"]],
    ["officecli batch report.pptx < ops.json", ["report.pptx"]],
    ['printf \'[{"command":"get","path":"/Sheet1/A1"}]\' | officecli batch report.xlsx', ["report.xlsx"]],
    ['cat ops.json | officecli batch "monthly report.xlsx"', ["monthly report.xlsx"]],
    [
      [
        "function officecli {",
        "param($verb, $file)",
        "[System.IO.File]::WriteAllBytes($file, [byte[]](80,75,3,4,9,8,7,6))",
        "}",
        'officecli batch "D:/work/report.docx" --commands \'[{"op":"set","path":"/body/p[1]"}]\'',
      ].join("\n"),
      ["D:/work/report.docx"],
    ],
  ])("extracts static OfficeCLI target: %s", (command, expected) => {
    expect(officeCliTargets(command)).toEqual(expected)
  })

  test.each([
    "officecli view report.docx outline",
    "officecli.exe view report.docx outline",
    "officecli batch readonly.officecli",
    "officecli set --profile profile.docx report.xlsx /Sheet1/A1 --prop value=hello",
    'cat ops.json | officecli batch "$FILE"',
    "officecli batch %FILE%",
  ])("ignores non-static or read-only target: %s", (command) => {
    expect(officeCliTargets(command)).toEqual([])
  })
})

describe("nonOfficeCliCommandText", () => {
  test("keeps side-effect commands outside exact OfficeCLI targets", () => {
    expect(nonOfficeCliCommandText("officecli batch report.docx && echo notes > notes.txt")).toBe(
      "echo notes > notes.txt",
    )
  })

  test("does not treat piped stdin producer as a write command by itself", () => {
    expect(nonOfficeCliCommandText("printf '[{\"command\":\"get\"}]' | officecli batch report.xlsx")).toBe(
      'printf \'[{"command":"get"}]\'',
    )
  })
})
