import { describe, expect, mock, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { pawworkSkillCards } from "./pawwork-skill-meta"
import { startPawworkSkillSession } from "./session-new-view-start"

describe("new session skill cards", () => {
  test("all starter cards create a session and dispatch the expected built-in command", async () => {
    for (const card of pawworkSkillCards) {
      const create = mock(async () => ({ data: { id: `session-${card.name}` } }))
      const command = mock(async () => ({ data: undefined }))
      const remove = mock(async () => ({ data: undefined }))
      const promote = mock(() => undefined)
      const navigate = mock(() => undefined)

      await startPawworkSkillSession({
        name: card.name,
        client: {
          session: {
            create,
            command,
            delete: remove,
          },
        },
        directory: "repo",
        agent: "build",
        model: "openai/gpt-5",
        variant: "fast",
        locale: "pt-BR",
        promote,
        navigate,
        onSessionCreateFailed: () => {
          throw new Error("session create should not fail")
        },
      })

      expect(create).toHaveBeenCalledWith({ skill: card.name })
      expect(command).toHaveBeenCalledWith({
        sessionID: `session-${card.name}`,
        command: card.name,
        arguments: "",
        agent: "build",
        model: "openai/gpt-5",
        variant: "fast",
        locale: "pt-BR",
        parts: [],
      })
      expect(promote).toHaveBeenCalledWith("repo", `session-${card.name}`)
      expect(navigate).toHaveBeenCalledWith(`/${base64Encode("repo")}/session/session-${card.name}`)
      expect(remove).not.toHaveBeenCalled()
    }
  })

  test("deletes the created session and navigates back when command dispatch fails", async () => {
    const create = mock(async () => ({ data: { id: "session-document-processing" } }))
    const command = mock(async () => {
      throw new Error("boom")
    })
    const remove = mock(async () => ({ data: undefined }))
    const promote = mock(() => undefined)
    const navigate = mock(() => undefined)

    await expect(
      startPawworkSkillSession({
        name: "document-processing",
        client: {
          session: {
            create,
            command,
            delete: remove,
          },
        },
        directory: "repo",
        agent: "build",
        model: "openai/gpt-5",
        promote,
        navigate,
        onSessionCreateFailed: () => {
          throw new Error("session create should not fail")
        },
      }),
    ).rejects.toThrow("boom")

    expect(remove).toHaveBeenCalledWith({ sessionID: "session-document-processing" })
    expect(navigate).toHaveBeenLastCalledWith(`/${base64Encode("repo")}/session`)
  })
})
