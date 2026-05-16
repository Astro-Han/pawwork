import type { ProviderAuthMethod } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { List } from "@opencode-ai/ui/list"
import { TextField } from "@opencode-ai/ui/text-field"
import { createMemo, Match, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { getProviderOAuthSelectPromptState, type ProviderOAuthPrompt } from "./dialog-connect-provider-prompt-state"

export function ProviderOAuthPromptsView(props: {
  method: () => ProviderAuthMethod | undefined
  methodIndex: () => number | undefined
  onSubmit: (index: number, inputs?: Record<string, string>) => Promise<void>
}) {
  const language = useLanguage()
  const [formStore, setFormStore] = createStore({
    value: {} as Record<string, string>,
    index: 0,
  })

  const prompts = createMemo<NonNullable<ProviderAuthMethod["prompts"]>>(() => {
    const value = props.method()
    if (value?.type !== "oauth") return []
    return value.prompts ?? []
  })
  const matches = (prompt: ProviderOAuthPrompt, value: Record<string, string>) => {
    if (!prompt.when) return true
    const actual = value[prompt.when.key]
    if (actual === undefined) return false
    return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
  }
  const current = createMemo(() => {
    const all = prompts()
    const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
    if (index === -1) return
    return {
      index,
      prompt: all[index],
    }
  })
  const valid = createMemo(() => {
    const item = current()
    if (!item || item.prompt.type !== "text") return false
    const value = formStore.value[item.prompt.key] ?? ""
    return value.trim().length > 0
  })

  async function next(index: number, value: Record<string, string>) {
    const methodIndex = props.methodIndex()
    if (methodIndex === undefined) return
    const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
    if (next !== -1) {
      setFormStore("index", next)
      return
    }
    await props.onSubmit(methodIndex, value)
  }

  async function handleSubmit(e: SubmitEvent) {
    e.preventDefault()
    const item = current()
    if (!item || item.prompt.type !== "text") return
    if (!valid()) return
    await next(item.index, formStore.value)
  }

  const item = () => current()
  const text = createMemo(() => {
    const prompt = item()?.prompt
    if (!prompt || prompt.type !== "text") return
    return prompt
  })
  const select = createMemo(() => {
    const prompt = item()?.prompt
    if (!prompt || prompt.type !== "select") return
    return prompt
  })

  return (
    <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
      <Switch>
        <Match when={item()?.prompt.type === "text"}>
          <TextField
            type="text"
            label={text()?.message ?? ""}
            placeholder={text()?.placeholder}
            value={text() ? (formStore.value[text()!.key] ?? "") : ""}
            onChange={(value) => {
              const prompt = text()
              if (!prompt) return
              setFormStore("value", prompt.key, value)
            }}
          />
          <Button class="w-auto" type="submit" variant="primary" disabled={!valid()}>
            {language.t("common.continue")}
          </Button>
        </Match>
        <Match when={item()?.prompt.type === "select"}>
          <div class="w-full flex flex-col gap-1.5">
            <div class="text-body text-fg-base">{select()?.message}</div>
            <div>
              <List
                items={select()?.options ?? []}
                key={(x) => x.value}
                current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                onSelect={(value) => {
                  if (!value) return
                  const currentItem = item()
                  if (!currentItem) return
                  const nextState = getProviderOAuthSelectPromptState(currentItem, value, formStore.value)
                  if (!nextState) return
                  setFormStore("value", currentItem.prompt.key, value.value)
                  void next(nextState.index, nextState.value)
                }}
              >
                {(option) => (
                  <div class="w-full flex items-center gap-x-2">
                    <div class="w-4 h-2 rounded-[1px] bg-surface-sunken shadow-xs-border-base flex items-center justify-center">
                      <div class="w-2.5 h-0.5 ml-0 bg-icon-strong hidden" data-slot="list-item-extra-icon" />
                    </div>
                    <span>{option.label}</span>
                    <span class="text-body text-fg-weak">{option.hint}</span>
                  </div>
                )}
              </List>
            </div>
          </div>
        </Match>
      </Switch>
    </form>
  )
}
