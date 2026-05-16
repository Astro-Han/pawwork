import { showToast, type ToastOptions } from "@opencode-ai/ui/toast"

type Language = {
  t: (key: string) => string
}

type SessionShareClient = {
  share: (input: { sessionID: string }) => Promise<{ data?: { share?: { url?: string } } }>
  unshare: (input: { sessionID: string }) => Promise<unknown>
}

type Toast = (options: ToastOptions) => void

export async function writeTextWithBrowserClipboard(value: string) {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }

  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(value).then(
    () => true,
    () => false,
  )
}

async function copyShareUrl(options: {
  url: string
  existing: boolean
  language: Language
  write: (value: string) => Promise<boolean>
  toast: Toast
}) {
  const { url, existing, language, write, toast } = options
  if (!(await write(url))) {
    toast({
      title: language.t("toast.session.share.copyFailed.title"),
      variant: "error",
    })
    return false
  }

  toast({
    title: existing ? language.t("session.share.copy.copied") : language.t("toast.session.share.success.title"),
    description: language.t("toast.session.share.success.description"),
    variant: "success",
  })
  return true
}

export async function shareSessionCommand(options: {
  sessionID: string | undefined
  existingUrl: string | undefined
  client: SessionShareClient
  language: Language
  write?: (value: string) => Promise<boolean>
  toast?: Toast
}) {
  const { sessionID, existingUrl, client, language } = options
  const write = options.write ?? writeTextWithBrowserClipboard
  const toast = options.toast ?? showToast
  if (!sessionID) return

  if (existingUrl) {
    await copyShareUrl({ url: existingUrl, existing: true, language, write, toast })
    return
  }

  const url = await client
    .share({ sessionID })
    .then((res) => res.data?.share?.url)
    .catch(() => undefined)
  if (!url) {
    toast({
      title: language.t("toast.session.share.failed.title"),
      description: language.t("toast.session.share.failed.description"),
      variant: "error",
    })
    return
  }

  await copyShareUrl({ url, existing: false, language, write, toast })
}

export async function unshareSessionCommand(options: {
  sessionID: string | undefined
  client: SessionShareClient
  language: Language
  toast?: Toast
}) {
  const { sessionID, client, language } = options
  const toast = options.toast ?? showToast
  if (!sessionID) return

  await client
    .unshare({ sessionID })
    .then(() =>
      toast({
        title: language.t("toast.session.unshare.success.title"),
        description: language.t("toast.session.unshare.success.description"),
        variant: "success",
      }),
    )
    .catch(() =>
      toast({
        title: language.t("toast.session.unshare.failed.title"),
        description: language.t("toast.session.unshare.failed.description"),
        variant: "error",
      }),
    )
}
