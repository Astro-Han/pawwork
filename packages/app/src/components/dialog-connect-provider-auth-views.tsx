import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Match, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatProviderConnectError } from "./dialog-connect-provider-error"

type ProviderConnectInfo = {
  id: string
  name: string
}

export function ProviderApiAuthView(props: { provider: () => ProviderConnectInfo; onComplete: () => Promise<void> }) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [formStore, setFormStore] = createStore({
    value: "",
    error: undefined as string | undefined,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()

    const form = e.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const apiKey = formData.get("apiKey") as string

    if (!apiKey?.trim()) {
      setFormStore("error", language.t("provider.connect.apiKey.required"))
      return
    }

    setFormStore("error", undefined)
    await globalSDK.client.auth.set({
      providerID: props.provider().id,
      auth: {
        type: "api",
        key: apiKey,
      },
    })
    await props.onComplete()
  }

  return (
    <div class="flex flex-col gap-6">
      <Switch>
        <Match when={props.provider().id === "opencode"}>
          <div class="flex flex-col gap-4">
            <div class="text-body text-fg-base">{language.t("provider.connect.opencodeZen.line1")}</div>
            <div class="text-body text-fg-base">{language.t("provider.connect.opencodeZen.line2")}</div>
            <div class="text-body text-fg-base">
              {language.t("provider.connect.opencodeZen.visit.prefix")}
              <Link href="https://opencode.ai/zen" tabIndex={-1}>
                {language.t("provider.connect.opencodeZen.visit.link")}
              </Link>
              {language.t("provider.connect.opencodeZen.visit.suffix")}
            </div>
          </div>
        </Match>
        <Match when={true}>
          <div class="text-body text-fg-base">
            {language.t("provider.connect.apiKey.description", { provider: props.provider().name })}
          </div>
        </Match>
      </Switch>
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <TextField
          autofocus
          type="text"
          label={language.t("provider.connect.apiKey.label", { provider: props.provider().name })}
          placeholder={language.t("provider.connect.apiKey.placeholder")}
          name="apiKey"
          value={formStore.value}
          onChange={(v) => setFormStore("value", v)}
          validationState={formStore.error ? "invalid" : undefined}
          error={formStore.error}
        />
        <Button class="w-auto" type="submit" variant="primary">
          {language.t("common.continue")}
        </Button>
      </form>
    </div>
  )
}

export function ProviderOAuthCodeView(props: {
  provider: () => ProviderConnectInfo
  authorization: () => ProviderAuthAuthorization | undefined
  method: () => ProviderAuthMethod | undefined
  methodIndex: () => number | undefined
  onComplete: () => Promise<void>
}) {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const [formStore, setFormStore] = createStore({
    value: "",
    error: undefined as string | undefined,
  })

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()

    const form = e.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const code = formData.get("code") as string

    if (!code?.trim()) {
      setFormStore("error", language.t("provider.connect.oauth.code.required"))
      return
    }

    setFormStore("error", undefined)
    const result = await globalSDK.client.provider.oauth
      .callback({
        providerID: props.provider().id,
        method: props.methodIndex(),
        code,
      })
      .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
      .catch((error) => ({ ok: false as const, error }))
    if (result.ok) {
      await props.onComplete()
      return
    }
    setFormStore("error", formatProviderConnectError(result.error, language.t("provider.connect.oauth.code.invalid")))
  }

  return (
    <div class="flex flex-col gap-6">
      <div class="text-body text-fg-base">
        {language.t("provider.connect.oauth.code.visit.prefix")}
        <Link href={props.authorization()!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
        {language.t("provider.connect.oauth.code.visit.suffix", { provider: props.provider().name })}
      </div>
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <TextField
          autofocus
          type="text"
          label={language.t("provider.connect.oauth.code.label", { method: props.method()?.label ?? "" })}
          placeholder={language.t("provider.connect.oauth.code.placeholder")}
          name="code"
          value={formStore.value}
          onChange={(v) => setFormStore("value", v)}
          validationState={formStore.error ? "invalid" : undefined}
          error={formStore.error}
        />
        <Button class="w-auto" type="submit" variant="primary">
          {language.t("common.continue")}
        </Button>
      </form>
    </div>
  )
}
