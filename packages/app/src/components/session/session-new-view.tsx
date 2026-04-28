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
        <h1 class="text-28-regular text-text-strong">{language.t("session.new.title")}</h1>

        <Show when={props.composer}>
          <div class="mt-12 flex w-full max-w-[720px] flex-col items-center">
            {props.composer!({ onModeChange: setMode, selectedSkill })}
          </div>
        </Show>

        <div class="mt-6 flex w-fit max-w-[640px] flex-wrap items-center justify-center gap-3">
          <For each={pawworkSkillCards}>
            {(card) => {
              const isSelected = () => mode() === "normal" && selectedSkill() === card.name
              return (
                <button
                  type="button"
                  data-skill-card={card.name}
                  aria-pressed={isSelected()}
                  classList={{
                    "inline-flex h-7 items-center gap-1.5 rounded-xl border px-3 text-13-regular transition-colors": true,
                    "border-border-strong-base bg-transparent text-text-base hover:bg-surface-base-hover":
                      !isSelected(),
                    "border-border-interactive-base bg-surface-interactive-weak text-text-strong":
                      isSelected(),
                  }}
                  onClick={() => toggleSkill(card.name)}
                >
                  <Icon name={card.homeIcon} size="small" class="shrink-0 text-icon-weak" />
                  <span class="truncate">{language.t(card.titleKey)}</span>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
