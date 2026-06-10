import { expect, test } from "bun:test"
import { showAttachmentInFolder } from "./attachment-reveal"

test("showAttachmentInFolder reveals relative prompt file paths under the session directory", () => {
  const shown: string[] = []

  showAttachmentInFolder({
    platform: {
      showItemInFolder: async (path) => {
        shown.push(path)
      },
    },
    directory: "/repo/main",
    path: "src/foo.ts",
  })

  expect(shown).toEqual(["/repo/main/src/foo.ts"])
})

test("showAttachmentInFolder preserves absolute prompt file paths", () => {
  const shown: string[] = []

  showAttachmentInFolder({
    platform: {
      showItemInFolder: async (path) => {
        shown.push(path)
      },
    },
    directory: "/repo/main",
    path: "/tmp/drop.pdf",
  })

  expect(shown).toEqual(["/tmp/drop.pdf"])
})
