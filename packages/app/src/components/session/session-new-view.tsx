import { Icon } from "@opencode-ai/ui/icon"
import { For, createSignal, Show, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { pawworkSkillCards, type PawworkSkillName } from "./pawwork-skill-meta"

type ComposerCtx = {
  onModeChange: (mode: "normal" | "shell") => void
  selectedSkill: () => PawworkSkillName | undefined
}

export function NewSessionView(props: { composer?: (ctx: ComposerCtx) => JSX.Element }) {
  const language = useLanguage()
  const [selectedSkill, setSelectedSkill] = createSignal<PawworkSkillName | undefined>()
  const [mode, setMode] = createSignal<"normal" | "shell">("normal")

  const toggleSkill = (name: PawworkSkillName) => {
    setSelectedSkill((prev) => (prev === name ? undefined : name))
  }

  return (
    <div data-component="session-new-home" class="size-full overflow-y-auto">
      <div class="mx-auto flex w-full max-w-200 flex-col items-center px-6 pt-[28vh] pb-10 text-center md:px-8">
        <h1 class="text-20-medium text-text-strong">{language.t("session.new.title")}</h1>
        <p class="mt-3 text-14-regular text-text-weak">{language.t("session.new.subtitle")}</p>

        <div class="mt-8 grid w-fit max-w-[640px] grid-cols-1 gap-3 sm:grid-cols-3">
          <For each={pawworkSkillCards}>
            {(card) => {
              const isSelected = () => mode() === "normal" && selectedSkill() === card.name
              return (
                <button
                  type="button"
                  data-skill-card={card.name}
                  aria-pressed={isSelected()}
                  classList={{
                    "flex items-center justify-center gap-2 rounded-xl border px-6 py-3 transition-colors": true,
                    "border-border-weaker-base bg-surface-base hover:border-border-weak-base hover:bg-surface-raised-base-hover":
                      !isSelected(),
                    "border-border-interactive-base bg-surface-raised-base shadow-sm": isSelected(),
                  }}
                  onClick={() => toggleSkill(card.name)}
                >
                  <Icon
                    name={card.homeIcon}
                    size="normal"
                    class={`shrink-0 ${card.homeIconClass ?? ""}`}
                    style={card.homeIconStyle}
                  />
                  <span class="text-14-medium text-text-strong">{language.t(card.titleKey)}</span>
                </button>
              )
            }}
          </For>
        </div>

        <Show when={props.composer}>
          <div class="mt-8 flex w-full max-w-[640px] flex-col items-center">
            {props.composer!({ onModeChange: setMode, selectedSkill })}
          </div>
        </Show>
        <p class="mt-8 text-12-regular text-text-weaker">{language.t("session.new.reassurance")}</p>
      </div>
    </div>
  )
}
