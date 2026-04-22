import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

test("schema generator writes only the main config schema", async () => {
  await using tmp = await tmpdir()
  const configFile = path.join(tmp.path, "config.json")
  const extraIgnoredFile = path.join(tmp.path, "ignored.json")

  const proc = Bun.spawn(["bun", "script/schema.ts", configFile, extraIgnoredFile], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const exit = await proc.exited

  expect(exit).toBe(0)
  expect(await Bun.file(configFile).exists()).toBe(true)
  expect(await Bun.file(extraIgnoredFile).exists()).toBe(false)

  const schema = JSON.parse(await fs.readFile(configFile, "utf8")) as Record<string, unknown>
  expect(schema).toHaveProperty("allowComments", true)
  expect(schema).toHaveProperty("allowTrailingCommas", true)
})
