import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"

function workspaceControllerRoot() {
  const dsh = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json")
  const web = createRequire(dsh).resolve("@deepseek-ai/dsh-web-app/package.json")
  return path.dirname(createRequire(web).resolve("@deepseek-ai/dsh-api-workspace-controller/package.json"))
}

test("the first-use workspace is created under Documents/PawWork", async () => {
  const entry = path.join(workspaceControllerRoot(), "lib/types/default-directory.js")
  const { defaultWorkspaceDirectory } = await import(pathToFileURL(entry).href)
  const signal = new AbortController().signal
  await expect(defaultWorkspaceDirectory("/Users/someone/Documents", signal, { platform: "darwin" }))
    .resolves.toBe("/Users/someone/Documents/PawWork/default-workspace")
  await expect(defaultWorkspaceDirectory("C:\\Users\\someone\\Documents", signal, { platform: "win32" }))
    .resolves.toBe("C:\\Users\\someone\\Documents\\PawWork\\default-workspace")
})

test("no workspace-controller code still names the upstream directory", () => {
  const lib = path.join(workspaceControllerRoot(), "lib")
  const offenders = readdirSync(lib, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".js"))
    .filter((file) => /["']deepseek-harness["']/.test(readFileSync(path.join(lib, file), "utf8")))
  expect(offenders).toEqual([])
})
