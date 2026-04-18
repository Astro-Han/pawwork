import { For, Show, createSignal, type JSX } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"
import { useNavigate } from "@solidjs/router"
import { showToast } from "@opencode-ai/ui/toast"
import { Mark } from "@opencode-ai/ui/logo"
import { pawworkSkillCards, type PawworkSkillName } from "./pawwork-skill-meta"
import { startPawworkSkillSession } from "./session-new-view-start"

export function NewSessionView(props: { composer?: JSX.Element }) {
  const sdk = useSDK()
  const local = useLocal()
  const language = useLanguage()
  const navigate = useNavigate()
  const [pending, setPending] = createSignal<PawworkSkillName>()

  const start = async (name: PawworkSkillName) => {
    if (pending()) return

    const agent = local.agent.current()
    const model = local.model.current()

    if (!agent || !model) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    setPending(name)

    try {
      await startPawworkSkillSession({
        name,
        client: sdk.client,
        directory: sdk.directory,
        agent: agent.name,
        model: `${model.provider.id}/${model.id}`,
        variant: local.model.variant.current() ?? undefined,
        locale: language.intl(),
        promote: local.session.promote,
        navigate,
        onSessionCreateFailed: () => {
          throw new Error(language.t("prompt.toast.sessionCreateFailed.description"))
        },
      })
    } catch (error) {
      showToast({
        title: language.t("prompt.toast.commandSendFailed.title"),
        description: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    } finally {
      setPending(undefined)
    }
  }

  return (
    <div data-component="session-new-home" class="size-full overflow-y-auto px-6 py-8 md:px-8 md:py-10">
      <div class="mx-auto flex w-full max-w-200 flex-col items-center gap-6 text-center">
        <Mark class="w-10" />
        <div class="flex flex-col gap-2">
          <h1 class="text-24-medium text-text-strong">{language.t("session.new.title")}</h1>
          <p class="text-14-regular text-text-weak">{language.t("session.new.subtitle")}</p>
        </div>
        <div class="grid w-full max-w-170 gap-3 md:grid-cols-3">
          <For each={pawworkSkillCards}>
            {(card) => (
              <button
                type="button"
                data-skill-card={card.name}
                class="rounded-2xl border border-border-weak-base bg-surface-raised-strong p-4 text-left transition-colors hover:bg-surface-raised-base-hover disabled:cursor-not-allowed disabled:opacity-70"
                disabled={pending() === card.name}
                onClick={() => void start(card.name)}
              >
                <div class="text-24 leading-none">{card.emoji}</div>
                <div class="mt-3 text-16-medium text-text-strong">{language.t(card.titleKey)}</div>
                <div class="mt-1 text-14-regular text-text-weak">{language.t(card.descriptionKey)}</div>
              </button>
            )}
          </For>
        </div>
        <Show when={props.composer}>
          <div class="w-full max-w-170">{props.composer}</div>
        </Show>
      </div>
    </div>
  )
}
