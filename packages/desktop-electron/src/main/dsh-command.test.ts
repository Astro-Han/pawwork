import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createDshCommandRuntime } from "./dsh-command"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pawwork-dsh-command-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("PawWork DSH command runner", () => {
  test("runs the bundled DSH against the explicit PawWork home", async () => {
    const home = join(temporaryDirectory(), ".pawwork", "dsh")
    const execute = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "done\n" }))
    const runtime = createDshCommandRuntime({
      dshBin: "/app/dsh/lib/bin.js",
      env: { PATH: "/system/bin", DSH_HOME: "/ambient/.dsh" },
      executable: "/app/PawWork",
      home,
      platform: "darwin",
      pnpmBin: "/app/node_modules/pnpm/bin/pnpm.mjs",
      execute,
    })

    await expect(runtime.run(["plugin", "--profile", "web", "add", "@example/plugin"])).resolves.toEqual({
      stderr: "",
      stdout: "done\n",
    })

    const tools = join(home, ".tools")
    expect(execute).toHaveBeenCalledWith(
      "/app/PawWork",
      ["/app/dsh/lib/bin.js", "plugin", "--profile", "web", "add", "@example/plugin"],
      {
        cwd: home,
        env: expect.objectContaining({
          DSH_HOME: home,
          ELECTRON_RUN_AS_NODE: "1",
          PATH: `${tools}${delimiter}/system/bin`,
          PAWWORK_NODE_EXECUTABLE: "/app/PawWork",
          PAWWORK_PNPM_CLI: "/app/node_modules/pnpm/bin/pnpm.mjs",
        }),
      },
    )
    expect(readFileSync(join(tools, "pnpm"), "utf8")).toBe(
      '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$PAWWORK_PNPM_CLI" "$@"\n',
    )
    expect(statSync(join(tools, "pnpm")).mode & 0o777).toBe(0o700)
    expect(runtime.environment).toEqual(expect.objectContaining({
      DSH_HOME: home,
      PATH: `${tools}${delimiter}/system/bin`,
      PAWWORK_PNPM_CLI: "/app/node_modules/pnpm/bin/pnpm.mjs",
    }))
  })

  test("provides the bundled package manager to DSH on Windows", async () => {
    const home = join(temporaryDirectory(), ".pawwork", "dsh")
    const execute = vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" }))
    const runtime = createDshCommandRuntime({
      dshBin: "C:\\PawWork\\dsh\\bin.js",
      env: { PATH: "C:\\Windows\\System32" },
      executable: "C:\\PawWork\\PawWork.exe",
      home,
      platform: "win32",
      pnpmBin: "C:\\PawWork\\node_modules\\pnpm\\bin\\pnpm.mjs",
      execute,
    })

    await runtime.run(["plugin", "--profile", "web", "remove", "@example/plugin"])

    const tools = join(home, ".tools")
    expect(readFileSync(join(tools, "pnpm.cmd"), "utf8")).toBe(
      '@"%PAWWORK_NODE_EXECUTABLE%" "%PAWWORK_PNPM_CLI%" %*\r\n',
    )
    expect(execute).toHaveBeenCalledWith(
      "C:\\PawWork\\PawWork.exe",
      expect.any(Array),
      expect.objectContaining({ env: expect.objectContaining({ PATH: `${tools};C:\\Windows\\System32` }) }),
    )
    expect(runtime.environment.PATH).toBe(`${tools};C:\\Windows\\System32`)
  })
})
