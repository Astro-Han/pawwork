import { Schema } from "effect"
import DESCRIPTION from "../bash.txt"

export type Limits = {
  maxLines: number
  maxBytes: number
}

const POWERSHELL_CHAIN =
  "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."

const PWSH_CHAIN =
  "If the commands depend on each other and must run sequentially, chain them with '&&' (supported in PowerShell 7+, e.g., `git add . && git commit -m \"message\" && git push`). For maximum portability with Windows PowerShell 5.1, fall back to `cmd1; if ($?) { cmd2 }`."

const CMD_CHAIN =
  "If the commands depend on each other and must run sequentially, chain them with '&&' in cmd.exe (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before copy, or git add before git commit), run these operations sequentially instead."

const BASH_CHAIN =
  "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."

export function chainingFor(name: string) {
  if (name === "powershell") return POWERSHELL_CHAIN
  if (name === "pwsh") return PWSH_CHAIN
  if (name === "cmd") return CMD_CHAIN
  return BASH_CHAIN
}

export const EXPECTED_OUTPUTS_DESCRIPTION =
  "Absolute or workdir-relative file paths the command will create or modify. Set this ONLY for commands that produce deliverable artifacts (officecli writes to .docx / .xlsx / .pptx, scripts generating reports, binary outputs, or files written outside the working directory). DO NOT set it for: tests, builds, installs, package managers, git inspection (status / log / diff), lint / typecheck, cat / ls / grep / find, dev servers, or any read-only inspection. When unsure, leave it empty."

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "The command to execute" }),
    timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    }),
    expected_outputs: Schema.optional(
      Schema.Array(Schema.String).annotate({
        description: EXPECTED_OUTPUTS_DESCRIPTION,
      }),
    ),
    description: Schema.String.annotate({
      description:
        "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

export function render(input: {
  name: string
  platform: NodeJS.Platform
  directory: string
  tmp: string
  limits: Limits
}) {
  return DESCRIPTION.replaceAll("${directory}", input.directory)
    .replaceAll("${tmp}", input.tmp)
    .replaceAll("${os}", input.platform)
    .replaceAll("${shell}", input.name)
    .replaceAll("${chaining}", chainingFor(input.name))
    .replaceAll("${maxLines}", String(input.limits.maxLines))
    .replaceAll("${maxBytes}", String(input.limits.maxBytes))
}

export * as BashPrompt from "./prompt"
