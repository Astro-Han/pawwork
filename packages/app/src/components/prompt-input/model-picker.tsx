import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, createSignal, For, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "@/components/model-tooltip"
import { useLanguage } from "@/context/language"
import { compareModelsForDisplay } from "@/utils/model-order"
import { modelSupportsInput } from "@/components/prompt-input/attachment-routing"

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
  action?: JSX.Element
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
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
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
          <div class="w-full min-w-0 flex items-center gap-x-2 text-13-regular text-left">
            <span class="min-w-0 truncate">{i.name}</span>
            <For each={visible}>{(tag) => <Tag class="shrink-0">{language.t(`model.tag.${tag}`)}</Tag>}</For>
          </div>
        )
      }}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

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
  const dialog = useDialog()
  const providers = useProviders()
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
    if (ignoreFocusOutsideForPointerInside) {
      ignoreFocusOutsideForPointerInside = false
      event.preventDefault()
      return
    }
    close("outside")
  }

  const handleManage = () => {
    close("manage")
    void import("@/components/dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("@/components/dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const hasPaid = createMemo(() => providers.paid().length > 0)

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
          class="w-[340px] h-[400px] flex flex-col bg-surface-base z-50 outline-none overflow-hidden"
          style={{ "border-radius": "14px", "box-shadow": "var(--shadow-floating)" }}
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={handlePointerDownInside}
          onPointerDownOutside={() => close("outside")}
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
            class="p-1"
            action={
              <Show when={hasPaid()}>
                <div class="flex items-center gap-1">
                  <Tooltip placement="top" value={language.t("command.provider.connect")}>
                    <IconButton
                      icon="plus"
                      variant="ghost"
                      iconSize="small"
                      class="size-6"
                      aria-label={language.t("command.provider.connect")}
                      onClick={handleConnectProvider}
                    />
                  </Tooltip>
                  <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                    <IconButton
                      icon="sliders"
                      variant="ghost"
                      iconSize="small"
                      class="size-6"
                      aria-label={language.t("dialog.model.manage")}
                      onClick={handleManage}
                    />
                  </Tooltip>
                </div>
              </Show>
            }
          />
          <Show when={!hasPaid()}>
            <div class="border-t border-border-weaker p-1">
              <Button
                variant="ghost"
                class="w-full justify-start text-13-regular"
                icon="plus-small"
                onClick={handleConnectProvider}
              >
                {language.t("dialog.model.unpaid.addMore.title")}
              </Button>
            </div>
          </Show>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
