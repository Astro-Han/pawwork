import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"

test("build-node injects both release version and channel defines", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "../../script/build-node.ts"), "utf8")

  expect(source).toContain("OPENCODE_VERSION")
  expect(source).toContain("OPENCODE_CHANNEL")
  expect(source).toContain("Script.version")
  expect(source).toContain("Script.channel")
})

test("build-node externalizes OpenCLI so packaged adapter assets resolve from a real package root", async () => {
  const source = await fs.readFile(path.join(import.meta.dir, "../../script/build-node.ts"), "utf8")

  expect(source).toContain("OPENCLI_EXTERNALS")
  expect(source).toContain('"@jackwener/opencli/browser/cdp"')
  expect(source).toContain("...OPENCLI_EXTERNALS")
})
