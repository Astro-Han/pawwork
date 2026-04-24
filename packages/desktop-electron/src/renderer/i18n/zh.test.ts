import { describe, expect, test } from "bun:test"
import { dict as zh } from "./zh"

describe("desktop renderer zh copy", () => {
  test("does not expose the English product name in updater copy", () => {
    expect(zh["desktop.updater.none.message"]).toBe("你已经在使用最新版本。")
    expect(zh["desktop.updater.downloaded.prompt"]).toBe("已下载 {{version}} 版本，是否安装并重启？")
  })
})
