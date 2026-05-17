import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, createSignal, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
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

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

type ModelState = ReturnType<typeof useLocal>["model"]

const [externalOpen, setExternalOpen] = createSignal(false)

export function openModelPicker() {
  setExternalOpen(true)
}

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  model?: ModelState
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
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
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

const ThinkingLevelSection: Component<{ model?: ModelState }> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()
  const variants = createMemo(() => model.variant.list())
  const current = createMemo(() => model.variant.current() ?? "default")
  const options = createMemo(() => ["default", ...variants()])

  const supported = createMemo(() => variants().length > 0)

  return (
    <div class="border-t border-border-weaker pt-3 pb-1">
      <Kobalte modal={false} placement="right-start" gutter={4}>
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
type Dismiss = "escape" | "outside" | "select"

const isPickerContentTarget = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("[data-picker-content]")

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const language = useLanguage()

  const open = createMemo(() => store.open || externalOpen())

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
    setExternalOpen(false)
  }
  let ignoreFocusOutsideForPointerInside = false

  const handlePointerDownInside = () => {
    ignoreFocusOutsideForPointerInside = true
    window.setTimeout(() => {
      ignoreFocusOutsideForPointerInside = false
    }, 0)
  }

  const handleFocusOutside = (
    event: Parameters<NonNullable<ComponentProps<typeof Kobalte.Content>["onFocusOutside"]>>[0],
  ) => {
    if (isPickerContentTarget(event.target)) {
      event.preventDefault()
      return
    }
    if (ignoreFocusOutsideForPointerInside) {
      ignoreFocusOutsideForPointerInside = false
      event.preventDefault()
      return
    }
    close("outside")
  }

  return (
    <Kobalte
      open={open()}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
        if (!next) setExternalOpen(false)
      }}
      modal={false}
      placement="bottom-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          data-picker-content=""
          class="w-[240px] h-[400px] flex flex-col z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={handlePointerDownInside}
          onPointerDownOutside={(event) => {
            // The nested ThinkingLevel popover renders into Kobalte.Portal, so
            // its Content sits outside this outer Content's DOM subtree. Without
            // this guard, clicks inside the inner picker satisfy "outside" for
            // the outer popover and dismiss the model picker before the inner
            // button click runs.
            if (isPickerContentTarget(event.target)) {
              event.preventDefault()
              return
            }
            close("outside")
          }}
          onFocusOutside={handleFocusOutside}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
          />
          <ThinkingLevelSection model={props.model} />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
