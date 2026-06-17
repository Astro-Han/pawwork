import { describe, expect, test } from "bun:test"
import { recordPickedModel } from "./record-picked-model"

function fakeClient(recordRecent?: (input: { providerID: string; modelID: string }) => Promise<unknown>) {
  const calls: Array<{ providerID: string; modelID: string }> = []
  return {
    calls,
    client: {
      provider: {
        recordRecent:
          recordRecent ??
          (async (input: { providerID: string; modelID: string }) => {
            calls.push(input)
            return true
          }),
      },
    },
  }
}

const item = { providerID: "deepseek", modelID: "deepseek-chat" }

describe("recordPickedModel", () => {
  test("records an explicit pick (recent: true) exactly once with the picked ref", () => {
    const { client, calls } = fakeClient()
    recordPickedModel(client, item, { recent: true })
    expect(calls).toEqual([item])
  })

  test("ignores a non-explicit set — model.cycle and plain set send no recent flag", () => {
    const { client, calls } = fakeClient()
    recordPickedModel(client, item, undefined)
    recordPickedModel(client, item, { recent: false })
    expect(calls).toEqual([])
  })

  test("ignores a cleared selection", () => {
    const { client, calls } = fakeClient()
    recordPickedModel(client, undefined, { recent: true })
    expect(calls).toEqual([])
  })

  test("swallows a rejected recordRecent so the pick is never disrupted", async () => {
    const { client } = fakeClient(async () => {
      throw new Error("offline")
    })
    expect(() => recordPickedModel(client, item, { recent: true })).not.toThrow()
    // let the rejected promise settle — .catch must absorb it (no unhandled rejection)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
