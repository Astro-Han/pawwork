import { describe, expect, test } from "bun:test"
import { readFile } from "fs/promises"
import path from "path"

const guardedTests = [
  {
    name: "FileWatcher live test suite",
    file: path.join(import.meta.dir, "watcher.test.ts"),
  },
  {
    name: "Vcs live watcher test suite",
    file: path.resolve(import.meta.dir, "../project/vcs.test.ts"),
  },
]

describe("watcher CI skip guards", () => {
  for (const item of guardedTests) {
    test(`${item.name} checks CI before probing native bindings`, async () => {
      const source = await readFile(item.file, "utf8")
      const ciGuard = source.indexOf("!process.env.CI")
      const nativeProbe = source.indexOf("FileWatcher.hasNativeBinding()")

      expect(ciGuard).toBeGreaterThanOrEqual(0)
      expect(nativeProbe).toBeGreaterThanOrEqual(0)
      expect(ciGuard).toBeLessThan(nativeProbe)
    })
  }
})
