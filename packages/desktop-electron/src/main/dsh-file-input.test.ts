import { describe, expect, test } from "bun:test"
import { pickConversationFiles } from "./dsh-file-input"

describe("PawWork DSH file input", () => {
  test("returns exactly the paths selected by the user", async () => {
    const paths = ["/outside/photo.png", "/outside/brief.pdf", "/outside/notes.md"]
    const result = await pickConversationFiles(async () => ({ canceled: false, filePaths: paths }))

    expect(result).toEqual({ status: "selected", paths })
  })

  test("returns canceled without any selected paths", async () => {
    const result = await pickConversationFiles(async () => ({ canceled: true, filePaths: [] }))

    expect(result).toEqual({ status: "canceled" })
  })
})
