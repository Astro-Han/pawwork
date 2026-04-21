import { describe, expect, test } from "bun:test"
import { updaterDialogLabels } from "./updater-dialog-labels"

describe("updater dialog labels", () => {
  test("localizes simplified Chinese labels", () => {
    const labels = updaterDialogLabels("zh")

    expect(labels.busy.title).toBe("正在检查更新")
    expect(labels.disabled.message).toBe("此构建不支持更新。")
    expect(labels.failed.title).toBe("检查更新失败")
    expect(labels.none.message).toBe("PawWork 已是最新版本。")
    expect(labels.ready.message("0.2.5")).toBe("更新 0.2.5 已下载。现在重启？")
    expect(labels.ready.buttons).toEqual(["重启", "稍后"])
  })

  test("returns English labels", () => {
    const labels = updaterDialogLabels("en")

    expect(labels.busy.title).toBe("Update Check in Progress")
    expect(labels.ready.message(undefined)).toBe("Update downloaded. Restart now?")
  })

  test("falls back to English for unexpected runtime locale values", () => {
    const labels = updaterDialogLabels("fr" as never)

    expect(labels.busy.title).toBe("Update Check in Progress")
    expect(labels.none.message).toBe("You're up to date.")
  })
})
