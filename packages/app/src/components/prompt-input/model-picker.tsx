import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, createSignal, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import type { ModelKey } from "@/context/models"
import { popularProviders } from "@/hooks/use-providers"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "@/components/model-tooltip"
import { useLanguage } from "@/context/language"
import { compareModelsForDisplay } from "@/utils/model-order"
import { modelSupportsInput } from "@/components/prompt-input/attachment-routing"
import { translateVariant } from "@/components/prompt-input/variant-label"
import { selectModel } from "./model-picker-select"

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

// The picker reads only this slice of the local model state. Decoupling it from
// useLocal lets the Automations create card (which renders outside the
// per-directory LocalProvider) drive the same UI from a panel-local controller
// (see pages/automations/automation-model-state). The full useLocal().model is
// a structural superset, so existing composer call sites are unaffected.
export type PickerModel = ReturnType<ReturnType<typeof useLocal>["model"]["list"]>[number]
export interface ModelPickerState {
  list: () => PickerModel[]
  current: () => PickerModel | undefined
  visible: (item: ModelKey) => boolean
  set: (item: ModelKey | undefined, options?: { recent?: boolean }) => void
  variant: {
    list: () => string[]
    current: () => string | undefined
    set: (value: string | undefined) => void
  }
}

const [externalOpen, setExternalOpen] = createSignal(false)

export function openModelPicker() {
  setExternalOpen(true)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  model?: ModelPickerState
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const models = createMemo(() =>
    model
      .list()
      .filter((m) => model.visible({ modelID: m.id, providerID: m.provider.id }))
      .filter((m) => (props.provider ? m.provider.id === props.provider : true)),
  )

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      sortBy={compareModelsForDisplay}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={(item, node) => (
        <Tooltip
          class="w-full"
          placement="right-start"
          gutter={12}
          value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
        >
          {node}
        </Tooltip>
      )}
      onSelect={(x) => {
        selectModel(model, x)
        props.onSelect()
      }}
    >
      {(i) => {
        const tagNames: Array<"free" | "image" | "latest"> = []
        if (isFree(i.provider.id, i.cost)) tagNames.push("free")
        if (modelSupportsInput(i, "image")) tagNames.push("image")
        if (i.latest) tagNames.push("latest")
        const visible = tagNames.slice(0, 2)
        return (
          <div class="w-full min-w-0 flex items-center gap-x-3 text-body text-left">
            <ProviderIcon id={i.provider.id} class="size-4 shrink-0 text-fg-base" />
            <span class="min-w-0 truncate">{i.name}</span>
            <For each={visible}>{(tag) => <Tag class="shrink-0">{language.t(`model.tag.${tag}`)}</Tag>}</For>
          </div>
        )
      }}
    </List>
  )
}

const ThinkingLevelSection: Component<{ model?: ModelPickerState; modal?: boolean }> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const variants = createMemo(() => model.variant.list())
  const current = createMemo(() => model.variant.current() ?? "default")
  const options = createMemo(() => ["default", ...variants()])

  const supported = createMemo(() => variants().length > 0)

  return (
    <div class="border-t border-border-weaker pt-3 pb-1">
      {/* Inherit the outer picker's modality. A non-modal nested popover opened
          inside a modal outer would lose focus to the outer's trap the instant
          it autofocuses and dismiss itself (the #950 PR7 thinking-submenu flash);
          a modal inner traps focus into itself and stays open. Composer keeps the
          outer (and so this) non-modal. */}
      <Kobalte modal={props.modal ?? false} placement="right-start" gutter={4}>
        <Kobalte.Trigger
          disabled={!supported()}
          data-action="prompt-model-thinking-trigger"
          class="group/think w-full h-[30px] px-2 gap-3 flex items-center rounded-[6px] text-body text-fg-base text-left hover:bg-row-hover-overlay hover:text-fg-strong data-[expanded]:bg-row-hover-overlay data-[expanded]:text-fg-strong disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-base"
        >
          <span>{language.t("dialog.model.variant")}</span>
          <span class="ml-auto text-fg-weak">{translateVariant(language.t, current())}</span>
          <Icon
            name="chevron-right"
            class="size-3.5 text-icon-weak transition-transform duration-150 group-data-[expanded]/think:rotate-90"
          />
        </Kobalte.Trigger>
        <Show when={supported()}>
          <Kobalte.Portal>
            <Kobalte.Content data-picker-content="" class="min-w-[140px] z-50 outline-none">
              <For each={options()}>
                {(opt) => (
                  <button
                    type="button"
                    data-picker-item=""
                    data-action="prompt-model-thinking-option"
                    data-variant={opt}
                    data-selected={opt === current() ? "" : undefined}
                    class="w-full"
                    onClick={() => model.variant.set(opt === "default" ? undefined : opt)}
                  >
                    {translateVariant(language.t, opt)}
                  </button>
                )}
              </For>
            </Kobalte.Content>
          </Kobalte.Portal>
        </Show>
      </Kobalte>
    </div>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelPickerState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
  // Inside a modal dialog (the Automations create card) the picker must be modal
  // too: the parent dialog's focus trap steals focus on open, and a non-modal
  // popover treats that as a focus-outside and dismisses (the #950 PR7 flash).
  // Kobalte only preventDefaults focus-outside for modal content. Default false
  // keeps the composer behaviour (close when keyboard focus leaves) intact.
  modal?: boolean
}) {
  const [store, setStore] = createStore<{ open: boolean }>({ open: false })
  const language = useLanguage()

  const open = createMemo(() => store.open || externalOpen())

  // Dismiss is delegated to Kobalte's native, layer-aware DismissableLayer: the
  // parent dialog is recognised as an ancestor layer and the nested Thinking
  // popover registers as a child layer, so neither trips an outside-dismiss. We
  // only track *why* the picker closed, so the composer can restore focus to the
  // prompt on escape/select — an outside dismiss must leave focus where it went.
  let closeCause: "escape" | "select" | null = null

  const selectAndClose = () => {
    closeCause = "select"
    setStore("open", false)
    setExternalOpen(false)
  }

  return (
    <Kobalte
      open={open()}
      onOpenChange={(next) => {
        setStore("open", next)
        if (!next) setExternalOpen(false)
      }}
      modal={props.modal ?? false}
      placement="bottom-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          data-picker-content=""
          class="w-[240px] max-h-[400px] flex flex-col z-50 outline-none overflow-hidden"
          onEscapeKeyDown={() => {
            // Record the cause and let Kobalte's top-most-layer Escape do the
            // close; don't preventDefault, so a parent dialog stays open.
            closeCause = "escape"
          }}
          onCloseAutoFocus={(event) => {
            const cause = closeCause
            closeCause = null
            if (cause) {
              event.preventDefault()
              props.onClose?.(cause)
            }
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList provider={props.provider} model={props.model} onSelect={selectAndClose} />
          <ThinkingLevelSection model={props.model} modal={props.modal} />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
