import { describe, expect, test } from "bun:test"
import { shareSessionCommand, unshareSessionCommand } from "./session-share-command"

const language = {
  t: (key: string) => key,
}

function createClient(options?: { shareUrl?: string; shareReject?: boolean; unshareReject?: boolean }) {
  const calls = {
    share: [] as { sessionID: string }[],
    unshare: [] as { sessionID: string }[],
  }
  return {
    calls,
    client: {
      async share(input: { sessionID: string }) {
        calls.share.push(input)
        if (options?.shareReject) throw new Error("share failed")
        return { data: { share: { url: options?.shareUrl } } }
      },
      async unshare(input: { sessionID: string }) {
        calls.unshare.push(input)
        if (options?.unshareReject) throw new Error("unshare failed")
        return {}
      },
    },
  }
}

describe("shareSessionCommand", () => {
  test("copies an existing share url without creating a new share", async () => {
    const { client, calls } = createClient({ shareUrl: "https://new.example/session" })
    const copied: string[] = []
    const toasts: unknown[] = []

    await shareSessionCommand({
      sessionID: "ses_1",
      existingUrl: "https://existing.example/session",
      client,
      language,
      write: async (value) => {
        copied.push(value)
        return true
      },
      toast: (toast) => toasts.push(toast),
    })

    expect(calls.share).toEqual([])
    expect(copied).toEqual(["https://existing.example/session"])
    expect(toasts).toContainEqual({
      title: "session.share.copy.copied",
      description: "toast.session.share.success.description",
      variant: "success",
    })
  })

  test("creates a share and copies the returned url", async () => {
    const { client, calls } = createClient({ shareUrl: "https://new.example/session" })
    const copied: string[] = []
    const toasts: unknown[] = []

    await shareSessionCommand({
      sessionID: "ses_1",
      existingUrl: undefined,
      client,
      language,
      write: async (value) => {
        copied.push(value)
        return true
      },
      toast: (toast) => toasts.push(toast),
    })

    expect(calls.share).toEqual([{ sessionID: "ses_1" }])
    expect(copied).toEqual(["https://new.example/session"])
    expect(toasts).toContainEqual({
      title: "toast.session.share.success.title",
      description: "toast.session.share.success.description",
      variant: "success",
    })
  })

  test("shows a share failure toast when no url is returned", async () => {
    const { client } = createClient()
    const copied: string[] = []
    const toasts: unknown[] = []

    await shareSessionCommand({
      sessionID: "ses_1",
      existingUrl: undefined,
      client,
      language,
      write: async (value) => {
        copied.push(value)
        return true
      },
      toast: (toast) => toasts.push(toast),
    })

    expect(copied).toEqual([])
    expect(toasts).toContainEqual({
      title: "toast.session.share.failed.title",
      description: "toast.session.share.failed.description",
      variant: "error",
    })
  })

  test("shows a copy failure toast when clipboard write fails", async () => {
    const { client } = createClient({ shareUrl: "https://new.example/session" })
    const toasts: unknown[] = []

    await shareSessionCommand({
      sessionID: "ses_1",
      existingUrl: undefined,
      client,
      language,
      write: async () => false,
      toast: (toast) => toasts.push(toast),
    })

    expect(toasts).toContainEqual({
      title: "toast.session.share.copyFailed.title",
      variant: "error",
    })
  })
})

describe("unshareSessionCommand", () => {
  test("unshares the current session and shows success", async () => {
    const { client, calls } = createClient()
    const toasts: unknown[] = []

    await unshareSessionCommand({
      sessionID: "ses_1",
      client,
      language,
      toast: (toast) => toasts.push(toast),
    })

    expect(calls.unshare).toEqual([{ sessionID: "ses_1" }])
    expect(toasts).toContainEqual({
      title: "toast.session.unshare.success.title",
      description: "toast.session.unshare.success.description",
      variant: "success",
    })
  })

  test("shows failure when unshare rejects", async () => {
    const { client } = createClient({ unshareReject: true })
    const toasts: unknown[] = []

    await unshareSessionCommand({
      sessionID: "ses_1",
      client,
      language,
      toast: (toast) => toasts.push(toast),
    })

    expect(toasts).toContainEqual({
      title: "toast.session.unshare.failed.title",
      description: "toast.session.unshare.failed.description",
      variant: "error",
    })
  })
})
