import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createResource, Match, onCleanup, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { clientActionHeaders } from "@/utils/server"
import {
  ProviderApiAuthView,
  ProviderOAuthCodeView,
} from "./dialog-connect-provider-auth-views"
import { ProviderOAuthAutoView } from "./dialog-connect-provider-auto-view"
import { formatProviderConnectError } from "./dialog-connect-provider-error"
import { ProviderOAuthPromptsView } from "./dialog-connect-provider-prompt-view"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const providers = useProviders()

  const all = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(
    () =>
      providers.all().find((x) => x.id === props.provider) ??
      globalSync.data.provider.all.find((x) => x.id === props.provider)!,
  )
  const fallback = createMemo<ProviderAuthMethod[]>(() => [
    {
      type: "api" as const,
      label: language.t("provider.connect.method.apiKey"),
    },
  ])
  const [auth] = createResource(
    () => props.provider,
    async () => {
      const cached = globalSync.data.provider_auth[props.provider]
      if (cached) return cached
      const res = await globalSDK.client.provider.auth()
      if (!alive.value) return fallback()
      globalSync.set("provider_auth", res.data ?? {})
      return res.data?.[props.provider] ?? fallback()
    },
  )
  const loading = createMemo(() => auth.loading && !globalSync.data.provider_auth[props.provider])
  const methods = createMemo(() => auth.latest ?? globalSync.data.provider_auth[props.provider] ?? fallback())
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: ProviderAuthAuthorization }
    | { type: "auth.error"; error: string }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex!) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "api") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]
    dispatch({ type: "method.select", index })

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      const start = Date.now()
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
            inputs,
          },
          { throwOnError: true },
        )
        .then((x) => {
          if (!alive.value) return
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (!alive.value) return
              dispatch({ type: "auth.complete", authorization: x.data! })
            }, delay)
            return
          }
          dispatch({ type: "auth.complete", authorization: x.data! })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: formatProviderConnectError(e, language.t("common.requestFailed")) })
        })
    }
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    if (methods().length === 1) {
      auto = true
      selectMethod(0)
    }
  })

  async function complete() {
    const actionClient = globalSDK.createClient({
      headers: clientActionHeaders({ kind: "settings.provider.connect" }),
      throwOnError: true,
    })
    await actionClient.global.dispose()
    dialog.close()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
      description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
    })
  }

  function goBack() {
    if (methods().length === 1) {
      all()
      return
    }
    if (store.authorization) {
      dispatch({ type: "method.reset" })
      return
    }
    if (store.methodIndex !== undefined) {
      dispatch({ type: "method.reset" })
      return
    }
    all()
  }

  function MethodSelection() {
    return (
      <>
        <div class="text-body text-fg-base">
          {language.t("provider.connect.selectMethod", { provider: provider().name })}
        </div>
        <div>
          <List
            ref={(ref) => {
              listRef = ref
            }}
            items={methods}
            key={(m) => m?.label}
            onSelect={async (selected, index) => {
              if (!selected) return
              selectMethod(index)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-surface-sunken shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  return (
    <Dialog
      title={
        <IconButton
          tabIndex={-1}
          icon="arrow-left"
          variant="ghost"
          onClick={goBack}
          aria-label={language.t("common.goBack")}
        />
      }
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <ProviderIcon id={props.provider} class="size-5 shrink-0 text-icon-strong" />
          <div class="text-h2 text-fg-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                {language.t("provider.connect.title.anthropicProMax")}
              </Match>
              <Match when={true}>{language.t("provider.connect.title", { provider: provider().name })}</Match>
            </Switch>
          </div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <div onKeyDown={handleKey} tabIndex={0} autofocus={store.methodIndex === undefined ? true : undefined}>
            <Switch>
              <Match when={loading()}>
                <div class="text-body text-fg-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.methodIndex === undefined}>
                <MethodSelection />
              </Match>
              <Match when={store.state === "pending"}>
                <div class="text-body text-fg-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.state === "prompt"}>
                <ProviderOAuthPromptsView
                  method={method}
                  methodIndex={() => store.methodIndex}
                  onSubmit={selectMethod}
                />
              </Match>
              <Match when={store.state === "error"}>
                <div class="text-body text-fg-base">
                  <div class="flex items-center gap-x-2">
                    <Icon name="circle-ban-sign" class="text-error" />
                    <span>{language.t("provider.connect.status.failed", { error: store.error ?? "" })}</span>
                  </div>
                </div>
              </Match>
              <Match when={method()?.type === "api"}>
                <ProviderApiAuthView provider={provider} onComplete={complete} />
              </Match>
              <Match when={method()?.type === "oauth"}>
                <Switch>
                  <Match when={store.authorization?.method === "code"}>
                    <ProviderOAuthCodeView
                      provider={provider}
                      authorization={() => store.authorization}
                      method={method}
                      methodIndex={() => store.methodIndex}
                      onComplete={complete}
                    />
                  </Match>
                  <Match when={store.authorization?.method === "auto"}>
                    <ProviderOAuthAutoView
                      provider={provider}
                      authorization={() => store.authorization}
                      methodIndex={() => store.methodIndex}
                      alive={() => alive.value}
                      onComplete={complete}
                      onError={(error) => dispatch({ type: "auth.error", error })}
                    />
                  </Match>
                </Switch>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
