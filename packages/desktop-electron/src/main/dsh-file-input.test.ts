import { describe, expect, test } from "bun:test"
import { pickConversationFiles } from "./dsh-file-input"

describe("PawWork DSH file input", () => {
  test("returns exactly the paths selected by the user", async () => {
    const paths = ["/outside/photo.png", "/outside/brief.pdf", "/outside/notes.md"]
    let receivedOptions: unknown
    const result = await pickConversationFiles(
      "http://127.0.0.1:53501/",
      "http://127.0.0.1:53501/session/1",
      async (options) => {
        receivedOptions = options
        return { canceled: false, filePaths: paths }
      },
    )

    expect(receivedOptions).toEqual({ properties: ["openFile", "multiSelections"] })
    expect(result).toEqual({ status: "selected", paths })
  })

  test("returns canceled without any selected paths", async () => {
    const result = await pickConversationFiles(
      "http://127.0.0.1:53501/",
      "http://127.0.0.1:53501/",
      async () => ({ canceled: true, filePaths: [] }),
    )

    expect(result).toEqual({ status: "canceled" })
  })

  test("rejects file picker requests from outside the owned DSH origin", async () => {
    let opened = false

    await expect(
      pickConversationFiles("http://127.0.0.1:53501/", "https://example.com/", async () => {
        opened = true
        return { canceled: true, filePaths: [] }
      }),
    ).rejects.toThrow("File picker requests must come from the owned DSH origin")
    expect(opened).toBe(false)
  })
})
