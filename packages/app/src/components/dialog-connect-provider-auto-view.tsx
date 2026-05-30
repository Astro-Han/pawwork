import type { ProviderAuthAuthorization } from "@opencode-ai/sdk/v2/client"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, onMount } from "solid-js"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatProviderConnectError } from "./dialog-connect-provider-error"

type ProviderConnectInfo = {
  id: string
  name: string
}

export function ProviderOAuthAutoView(props: {
  provider: () => ProviderConnectInfo
  authorization: () => ProviderAuthAuthorization | undefined
  methodIndex: () => number | undefined
  alive: () => boolean
  onComplete: () => Promise<void>
  onError: (error: string) => void
}) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const code = createMemo(() => {
    const instructions = props.authorization()?.instructions
    if (instructions?.includes(":")) {
      return instructions.split(":")[1]?.trim()
    }
    return instructions
  })

  onMount(() => {
    void (async () => {
      const methodIndex = props.methodIndex()
      if (methodIndex === undefined) {
        props.onError(language.t("common.requestFailed"))
        return
      }

      const result = await globalSDK.client.provider.oauth
        .callback({
          providerID: props.provider().id,
          method: methodIndex,
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))

      if (!props.alive()) return

      if (!result.ok) {
        const message = formatProviderConnectError(result.error, language.t("common.requestFailed"))
        props.onError(message)
        return
      }

      await props.onComplete()
    })()
  })

  return (
    <div class="flex flex-col gap-6">
      <div class="text-body text-fg-base">
        {language.t("provider.connect.oauth.auto.visit.prefix")}
        <Link href={props.authorization()!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
        {language.t("provider.connect.oauth.auto.visit.suffix", { provider: props.provider().name })}
      </div>
      <TextField
        label={language.t("provider.connect.oauth.auto.confirmationCode")}
        class="font-mono"
        value={code()}
        readOnly
        copyable
      />
      <div class="text-body text-fg-base flex items-center gap-4">
        <Spinner />
        <span>{language.t("provider.connect.status.waiting")}</span>
      </div>
    </div>
  )
}
