import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2/client"
import { createPendingQuestionController, type PendingQuestionAlert } from "./pending-question-controller"
import type { PendingQuestion, PendingQuestionIndex } from "./pending-question-index"

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const questionPart = (input: {
  id: string
  sessionID: string
  messageID: string
  callID: string
  status?: "running" | "completed" | "error"
}): Part =>
  ({
    id: input.id,
    type: "tool",
    tool: "question",
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID: input.callID,
    state: {
      status: input.status ?? "running",
      input: { questions: [{ question: "?" }] },
      title: "",
      metadata: { externalResultReady: true },
      time: { start: 0 },
    },
  }) as Part

const question = (input: { sessionID: string; messageID: string; callID: string }): PendingQuestion => ({
  id: `${input.messageID}:${input.callID}`,
  sessionID: input.sessionID,
  questions: [{ question: "?" }],
  messageID: input.messageID,
  callID: input.callID,
  partID: `prt_${input.callID}`,
})

function setup(resolveParentID?: (directory: string, sessionID: string) => string | undefined | Promise<string | undefined>) {
  let index: PendingQuestionIndex = {}
  const alerts: PendingQuestionAlert[] = []
  const parents: Record<string, string> = {}
  const controller = createPendingQuestionController({
    read: () => index,
    write: (mutate) => mutate(index),
    resolveParentID: resolveParentID ?? ((_directory, sessionID) => parents[sessionID]),
  })
  controller.onAlert((event) => alerts.push(event))
  return { controller, getIndex: () => index, alerts, parents }
}

const updated = (part: Part) => ({ type: "message.part.updated", properties: { part } }) as const

describe("createPendingQuestionController applyEvent", () => {
  test("a live question part adds the entry, resolves its root, and alerts once", async () => {
    const { controller, getIndex, alerts, parents } = setup()
    parents["child"] = "root"

    const part = questionPart({ id: "p1", sessionID: "child", messageID: "m1", callID: "c1" })
    controller.applyEvent("/dir", updated(part))
    await flush()

    expect(getIndex()["/dir"]["child"][0]).toMatchObject({ id: "m1:c1", rootSessionID: "root" })
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ directory: "/dir", askSessionID: "child", rootSessionID: "root" })

    // A second update for the same identity is not a rising edge → no new alert.
    controller.applyEvent("/dir", updated(part))
    await flush()
    expect(alerts).toHaveLength(1)
  })

  test("attributes a root-level question to its own session", async () => {
    const { controller, getIndex, alerts } = setup()
    controller.applyEvent("/dir", updated(questionPart({ id: "p1", sessionID: "root", messageID: "m1", callID: "c1" })))
    await flush()
    expect(getIndex()["/dir"]["root"][0].rootSessionID).toBe("root")
    expect(alerts[0].rootSessionID).toBe("root")
  })

  test("a terminal question part retracts the entry", async () => {
    const { controller, getIndex } = setup()
    controller.applyEvent("/dir", updated(questionPart({ id: "p1", sessionID: "s1", messageID: "m1", callID: "c1" })))
    await flush()
    expect(getIndex()["/dir"]["s1"]).toHaveLength(1)

    controller.applyEvent(
      "/dir",
      updated(questionPart({ id: "p1", sessionID: "s1", messageID: "m1", callID: "c1", status: "completed" })),
    )
    expect(getIndex()["/dir"]).toBeUndefined()
  })

  test("message.part.removed, message.removed, session.deleted, and archive all retract", async () => {
    for (const event of [
      { type: "message.part.removed", properties: { messageID: "m1", partID: "p1" } },
      { type: "message.removed", properties: { messageID: "m1" } },
      { type: "session.deleted", properties: { info: { id: "s1" } } },
      { type: "session.updated", properties: { info: { id: "s1", time: { archived: 10 } } } },
    ]) {
      const { controller, getIndex } = setup()
      controller.applyEvent("/dir", updated(questionPart({ id: "p1", sessionID: "s1", messageID: "m1", callID: "c1" })))
      await flush()
      expect(getIndex()["/dir"]["s1"]).toHaveLength(1)
      controller.applyEvent("/dir", event)
      expect(getIndex()["/dir"]).toBeUndefined()
    }
  })

  test("ignores events without properties", () => {
    const { controller, getIndex } = setup()
    expect(() => controller.applyEvent("/dir", { type: "message.part.updated" })).not.toThrow()
    expect(getIndex()).toEqual({})
  })

  test("a removal landing mid-walk drops the entry and suppresses its alert", async () => {
    let release: ((id: string | undefined) => void) | undefined
    const gate = new Promise<string | undefined>((resolve) => {
      release = resolve
    })
    const { controller, getIndex, alerts } = setup(() => gate)

    controller.applyEvent("/dir", updated(questionPart({ id: "p1", sessionID: "child", messageID: "m1", callID: "c1" })))
    // Retract before the parent walk resolves.
    controller.applyEvent("/dir", { type: "message.part.removed", properties: { messageID: "m1", partID: "p1" } })
    release?.(undefined)
    await flush()

    expect(getIndex()["/dir"]).toBeUndefined()
    expect(alerts).toEqual([])
  })
})

describe("createPendingQuestionController reconcile", () => {
  test("seeds entries and resolves their roots without firing an alert", async () => {
    const { controller, getIndex, alerts, parents } = setup()
    parents["child"] = "root"

    controller.reconcile("/dir", [question({ sessionID: "child", messageID: "m1", callID: "c1" })])
    await flush()

    expect(getIndex()["/dir"]["child"][0]).toMatchObject({ id: "m1:c1", rootSessionID: "root" })
    expect(alerts).toEqual([])
  })

  test("an empty snapshot clears the directory", async () => {
    const { controller, getIndex } = setup()
    controller.applyEvent("/dir", updated(questionPart({ id: "p1", sessionID: "s1", messageID: "m1", callID: "c1" })))
    await flush()
    expect(getIndex()["/dir"]).toBeDefined()

    controller.reconcile("/dir", [])
    expect(getIndex()["/dir"]).toBeUndefined()
  })
})
