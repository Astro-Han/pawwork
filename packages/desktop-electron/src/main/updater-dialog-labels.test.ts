import { describe, expect, test } from "bun:test"
import { updaterDialogLabels } from "./updater-dialog-labels"

describe("updater dialog labels", () => {
  test("localizes simplified Chinese labels", () => {
    const labels = updaterDialogLabels("zh")

    expect(labels.busy.title).toBe("正在检查更新")
    expect(labels.busy.message).toBe("正在检查更新。")
    expect(labels.disabled.message).toBe("此构建不支持更新。")
    expect(labels.failed.title).toBe("更新失败")
    expect(labels.none.message).toBe("已是最新版本。")
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

  test("exposes reason-specific failed copy and recovery buttons in Simplified Chinese", () => {
    const labels = updaterDialogLabels("zh")

    expect(labels.failed.title).toBe("更新失败")
    expect(labels.failed.installFailedMessage).toBe("安装失败。")
    expect(labels.failed.reasonCopy.check).toBe("无法连接 GitHub。网络可能较慢或被阻断。")
    expect(labels.failed.reasonCopy.download).toBe("下载未完成。")
    expect(labels.failed.reasonCopy.metadata).toBe("更新信息不完整或无效。")
    expect(labels.failed.reasonCopy.cache).toBe("缓存的更新处于异常状态。")
    expect(labels.failed.currentVersionUnaffected).toBe("当前版本未受影响，可继续使用。")
    expect(labels.failed.buttons).toEqual({ retry: "重试", openDownloadPage: "打开下载页", later: "稍后" })
  })

  test("exposes reason-specific failed copy in English", () => {
    const labels = updaterDialogLabels("en")

    expect(labels.failed.title).toBe("Update Failed")
    expect(labels.failed.installFailedMessage).toBe("Installation failed.")
    expect(labels.failed.reasonCopy.check).toBe("Could not reach GitHub. The network may be slow or blocked.")
    expect(labels.failed.reasonCopy.download).toBe("The download did not complete.")
    expect(labels.failed.reasonCopy.metadata).toBe("The update information was incomplete or invalid.")
    expect(labels.failed.reasonCopy.cache).toBe("The cached update is in an unexpected state.")
    expect(labels.failed.currentVersionUnaffected).toBe("Your current version is unaffected and continues to work.")
    expect(labels.failed.buttons).toEqual({ retry: "Retry", openDownloadPage: "Open Download Page", later: "Later" })
  })
})
