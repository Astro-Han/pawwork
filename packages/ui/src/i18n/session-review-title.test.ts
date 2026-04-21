import { describe, expect, test } from "bun:test"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"

describe("session review title translations", () => {
  test("localizes Review change titles for Chinese users", () => {
    expect(zh["ui.sessionReview.title.git"]).toBe("文件变更")
    expect(zht["ui.sessionReview.title.git"]).toBe("檔案變更")
    expect(zh["ui.sessionReview.title.branch"]).toBe("分支变更")
    expect(zht["ui.sessionReview.title.branch"]).toBe("分支變更")
  })
})
