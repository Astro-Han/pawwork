import { describe, expect, test } from "bun:test"
import { isLikelyWriteCommand } from "../../src/tool/bash-write-heuristic"

const positive = [
  "echo x > foo",
  "false && echo x > foo",
  "ls ; sed -i 's/x/y/' foo",
  "mv a b",
  "cp a b",
  "rm a",
  "mkdir out",
  "touch file",
  "ls | tee out.txt",
  "yarn",
  "yarn add foo",
  "yarn run build",
  "npm install",
  "bun add solid-js",
  "pnpm run build",
  "cargo build",
  "go build ./...",
  "git checkout feature",
  "git apply patch.diff",
  "patch -p1 < fix.patch",
  "chmod +x script.sh",
  "chown user file",
  "ln -s a b",
  "truncate -s 0 file",
  "dd if=a of=b",
  "install src dest",
  "apply_patch < fix.patch",
  "perl -pi -e 's/a/b/' file",
  "awk -i inplace '{print}' file",
  "pip install foo",
  "uv add foo",
  "go get example.com/mod",
  "make build",
  "tsc -p tsconfig.json",
  "vite build",
  "git add file",
  "git restore file",
  "git clean -fd",
  "env FOO=bar npm install",
  "sudo FOO=bar touch file",
  "Set-Content a.txt x",
  "set-content a.txt x",
  "SET-CONTENT a.txt x",
  "New-Item a.txt",
  "Remove-Item a.txt",
  "Copy-Item a.txt b.txt",
  "Move-Item a.txt b.txt",
  "Out-File -FilePath a.txt",
  "Add-Content a.txt y",
  "Clear-Content a.txt",
  "Rename-Item a.txt b.txt",
  'pwsh -c "Set-Content a.txt x"',
  'powershell -c "Remove-Item a.txt"',
]

const negative = [
  "grep 'a > b' file.txt",
  'echo "use > to redirect"',
  "echo ok 2>&1",
  "cmd >&2",
  "ls",
  "cat foo",
  "grep pattern file",
  "grep rm file",
  "echo cp file",
  "printf 'git add file'",
  "pwd",
  "git status",
  "git log",
  "git diff",
  "find . -name '*.ts'",
  "echo hi",
  "wc -l foo",
  "Get-Content a.txt",
  "Select-String pattern a.txt",
  "Get-ChildItem",
  "Test-Path a.txt",
  "Get-Item a.txt",
]

describe("isLikelyWriteCommand", () => {
  test.each(positive)("detects write-like command: %s", (command) => {
    expect(isLikelyWriteCommand(command)).toBe(true)
  })

  test.each(negative)("ignores read-only command: %s", (command) => {
    expect(isLikelyWriteCommand(command)).toBe(false)
  })
})
