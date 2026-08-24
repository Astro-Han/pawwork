import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { prepareDshToolsEnvironment } from "./dsh-tools"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

test("keeps one Windows Path authority with bundled pnpm and Node commands", () => {
  const home = mkdtempSync(join(tmpdir(), "pawwork-dsh-tools-"))
  temporaryDirectories.push(home)

  const environment = prepareDshToolsEnvironment({
    dshBin: "C:\\PawWork\\dsh\\bin.js",
    env: { Path: "C:\\Windows\\System32" },
    executable: "C:\\PawWork\\PawWork.exe",
    home,
    hostToken: "host-token",
    platform: "win32",
    pnpmBin: "C:\\PawWork\\node_modules\\pnpm\\bin\\pnpm.mjs",
    productToolsDir: "C:\\PawWork\\resources\\tools",
  })

  const privateTools = join(home, ".tools")
  expect(environment).toEqual(expect.objectContaining({
    DSH_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
    PAWWORK_DSH_BIN: "C:\\PawWork\\dsh\\bin.js",
    PAWWORK_HOST_TOKEN: "host-token",
    PAWWORK_NODE_EXECUTABLE: "C:\\PawWork\\PawWork.exe",
    PAWWORK_PNPM_CLI: "C:\\PawWork\\node_modules\\pnpm\\bin\\pnpm.mjs",
    Path: `${privateTools};C:\\PawWork\\resources\\tools;C:\\Windows\\System32`,
  }))
  expect(environment.PATH).toBeUndefined()
  expect(readFileSync(join(privateTools, "node.cmd"), "utf8")).toBe(
    '@"%PAWWORK_NODE_EXECUTABLE%" %*\r\n',
  )
  expect(readFileSync(join(privateTools, "pnpm.cmd"), "utf8")).toBe(
    '@"%PAWWORK_NODE_EXECUTABLE%" "%PAWWORK_PNPM_CLI%" %*\r\n',
  )
})

test("makes the Electron-backed Node and pnpm commands executable on macOS", () => {
  const home = mkdtempSync(join(tmpdir(), "pawwork-dsh-tools-"))
  temporaryDirectories.push(home)

  const environment = prepareDshToolsEnvironment({
    dshBin: "/Applications/PawWork.app/dsh/bin.js",
    env: { PATH: "/usr/bin" },
    executable: "/Applications/PawWork.app/Contents/MacOS/PawWork",
    home,
    hostToken: "host-token",
    platform: "darwin",
    pnpmBin: "/Applications/PawWork.app/pnpm/bin/pnpm.mjs",
    productToolsDir: "/Applications/PawWork.app/tools",
  })

  const privateTools = join(home, ".tools")
  expect(environment.PATH).toBe(`${privateTools}:/Applications/PawWork.app/tools:/usr/bin`)
  expect(readFileSync(join(privateTools, "node"), "utf8")).toBe(
    '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$@"\n',
  )
  expect(readFileSync(join(privateTools, "pnpm"), "utf8")).toBe(
    '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$PAWWORK_PNPM_CLI" "$@"\n',
  )
})
