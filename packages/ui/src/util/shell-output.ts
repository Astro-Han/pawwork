import stripAnsi from "strip-ansi"

export function normalizeShellOutput(output: string) {
  return stripAnsi(output).replace(/\r\n?/g, "\n")
}
