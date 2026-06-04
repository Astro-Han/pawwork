import { Popover as Kobalte } from "@kobalte/core/popover"
import { ComponentProps, JSXElement, ParentProps, Show, createSignal, splitProps, ValidComponent } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface PopoverProps<T extends ValidComponent = "div">
  extends ParentProps,
    Omit<ComponentProps<typeof Kobalte>, "children"> {
  trigger?: JSXElement
  triggerAs?: T
  triggerProps?: ComponentProps<T>
  title?: JSXElement
  description?: JSXElement
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
  portal?: boolean
}

export function Popover<T extends ValidComponent = "div">(props: PopoverProps<T>) {
  const i18n = useI18n()
  const [local, rest] = splitProps(props, [
    "trigger",
    "triggerAs",
    "triggerProps",
    "title",
    "description",
    "class",
    "classList",
    "style",
    "children",
    "portal",
    "open",
    "defaultOpen",
    "onOpenChange",
    "modal",
  ])

  const [uncontrolledOpen, setUncontrolledOpen] = createSignal(local.defaultOpen ?? false)

  const controlled = () => local.open !== undefined
  const opened = () => {
    if (controlled()) return local.open ?? false
    return uncontrolledOpen()
  }

  const onOpenChange = (next: boolean) => {
    if (local.onOpenChange) local.onOpenChange(next)
    if (controlled()) return
    setUncontrolledOpen(next)
  }

  const content = () => (
    <Kobalte.Content
      data-component="popover-content"
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      style={local.style}
    >
      {/* <Kobalte.Arrow data-slot="popover-arrow" /> */}
      <Show when={local.title}>
        <div data-slot="popover-header">
          <Kobalte.Title data-slot="popover-title">{local.title}</Kobalte.Title>
          <Kobalte.CloseButton
            data-slot="popover-close-button"
            as={IconButton}
            icon="close"
            variant="ghost"
            aria-label={i18n.t("ui.common.close")}
          />
        </div>
      </Show>
      <Show when={local.description}>
        <Kobalte.Description data-slot="popover-description">{local.description}</Kobalte.Description>
      </Show>
      <div data-slot="popover-body">{local.children}</div>
    </Kobalte.Content>
  )

  return (
    <Kobalte gutter={8} {...rest} open={opened()} onOpenChange={onOpenChange} modal={local.modal ?? false}>
      <Kobalte.Trigger as={local.triggerAs ?? "div"} data-slot="popover-trigger" {...(local.triggerProps as any)}>
        {local.trigger}
      </Kobalte.Trigger>
      <Show when={local.portal ?? true} fallback={content()}>
        <Kobalte.Portal>{content()}</Kobalte.Portal>
      </Show>
    </Kobalte>
  )
}
