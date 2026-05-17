import { Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { HomeSuggestionList } from "@/components/home/home-suggestion-list"

type ComposerCtx = {
  onModeChange: (mode: "normal" | "shell") => void
}

export function NewSessionView(props: { composer?: (ctx: ComposerCtx) => JSX.Element }) {
  const language = useLanguage()

  return (
    <div data-component="session-new-home" class="size-full overflow-y-auto">
      <div class="mx-auto flex w-full flex-col items-center px-6 pt-[28vh] pb-10 text-center md:px-8">
        <h1
          class="text-display text-fg-strong"
          classList={{ "tracking-cjk": language.locale().startsWith("zh") }}
          lang={language.locale()}
        >
          {language.t("home.hero.title")}
        </h1>

        <Show when={props.composer}>
          <div class="mt-20 flex w-full max-w-[640px] flex-col items-center">
            {props.composer!({ onModeChange: () => {} })}
          </div>
          <HomeSuggestionList />
        </Show>
      </div>
    </div>
  )
}
