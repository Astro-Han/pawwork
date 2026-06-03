import type { Message } from "@opencode-ai/sdk/v2/client"
import { batch } from "solid-js"
import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import type { useGlobalSync } from "@/context/global-sync"
import type { useSDK } from "@/context/sdk"
import type { useSync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { buildRequestParts } from "./build-request-parts"
import { reportInvariantBreach } from "./invariant"
import { followupCommandText, type FollowupDraft } from "./followup-draft"

type FollowupSendInput = {
  client: ReturnType<typeof useSDK>["client"]
  globalSync: ReturnType<typeof useGlobalSync>
  sync: ReturnType<typeof useSync>
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = followupCommandText(input.draft)
  const images = draftImages(input.draft.prompt)
  const [, setStore] = input.globalSync.child(input.draft.sessionDirectory)

  const setBusy = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    setStore("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  // Path D: first prompt part is a marked TextPart (command metadata present).
  // flatText projects all content parts into a single string for argument slicing.
  // If the content prefix invariant is violated, report and fall through to legacy.
  const first = input.draft.prompt[0]
  if (first?.type === "text" && first.command) {
    const markedName = first.command.name
    const prefix = `/${markedName} `
    const flatText = input.draft.prompt
      .map((p) => ("content" in p ? p.content : ""))
      .join("")
    if (!flatText.startsWith(prefix)) {
      reportInvariantBreach("sendFollowupDraft: command content prefix mismatch", first)
      // Fall through to the legacy command check below.
    } else {
      setBusy()
      try {
        if (!(await wait())) {
          setIdle()
          return false
        }
        await input.client.session.command({
          sessionID: input.draft.sessionID,
          command: markedName,
          arguments: flatText.slice(prefix.length),
          agent: input.draft.agent,
          model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
          locale: input.draft.locale,
          variant: input.draft.variant,
          parts: images.map((attachment) => ({
            id: Identifier.ascending("part"),
            type: "file" as const,
            mime: attachment.mime,
            url: attachment.dataUrl,
            filename: attachment.filename,
          })),
        })
        return true
      } catch (err) {
        setIdle()
        throw err
      }
    }
  }

  // A draft carrying an inline skill chip flows through promptAsync below; its
  // text can start with "/name", which must not be misrouted to session.command.
  const hasSkillPart = input.draft.prompt.some((part) => part.type === "skill")
  const [head, ...tail] = text.split(" ")
  const cmd = !hasSkillPart && head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      await input.client.session.command({
        sessionID: input.draft.sessionID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: `${input.draft.model.providerID}/${input.draft.model.modelID}`,
        locale: input.draft.locale,
        variant: input.draft.variant,
        parts: images.map((attachment) => ({
          id: Identifier.ascending("part"),
          type: "file" as const,
          mime: attachment.mime,
          url: attachment.dataUrl,
          filename: attachment.filename,
        })),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.client.session.promptAsync({
      sessionID: input.draft.sessionID,
      agent: input.draft.agent,
      model: input.draft.model,
      locale: input.draft.locale,
      messageID,
      parts: requestParts,
      variant: input.draft.variant,
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}
