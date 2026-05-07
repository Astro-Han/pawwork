import { Toast as Kobalte, toaster } from "@kobalte/core/toast"
import type { ToastRootProps, ToastCloseButtonProps, ToastTitleProps, ToastDescriptionProps } from "@kobalte/core/toast"
import type { ComponentProps, JSX } from "solid-js"
import { onCleanup, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"

export interface ToastRegionProps extends ComponentProps<typeof Kobalte.Region> {}

function ToastRegion(props: ToastRegionProps) {
  return (
    <Portal>
      <Kobalte.Region data-component="toast-region" {...props}>
        <Kobalte.List data-slot="toast-list" />
      </Kobalte.Region>
    </Portal>
  )
}

export interface ToastRootComponentProps extends ToastRootProps {
  class?: string
  classList?: ComponentProps<"li">["classList"]
  children?: JSX.Element
}

function ToastRoot(props: ToastRootComponentProps) {
  return (
    <Kobalte
      data-component="toast"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      {...props}
    />
  )
}

function ToastIcon(props: { name: IconProps["name"] }) {
  return (
    <div data-slot="toast-icon">
      <Icon name={props.name} />
    </div>
  )
}

function ToastContent(props: ComponentProps<"div">) {
  return <div data-slot="toast-content" {...props} />
}

function ToastTitle(props: ToastTitleProps & ComponentProps<"div">) {
  return <Kobalte.Title data-slot="toast-title" {...props} />
}

function ToastDescription(props: ToastDescriptionProps & ComponentProps<"div">) {
  return <Kobalte.Description data-slot="toast-description" {...props} />
}

function ToastActions(props: ComponentProps<"div">) {
  return <div data-slot="toast-actions" {...props} />
}

function ToastCloseButton(props: ToastCloseButtonProps & ComponentProps<"button">) {
  const i18n = useI18n()
  return (
    <Kobalte.CloseButton
      data-slot="toast-close-button"
      as={IconButton}
      icon="close"
      variant="ghost"
      aria-label={i18n.t("ui.common.dismiss")}
      {...props}
    />
  )
}

function ToastProgressTrack(props: ComponentProps<typeof Kobalte.ProgressTrack>) {
  return <Kobalte.ProgressTrack data-slot="toast-progress-track" {...props} />
}

function ToastProgressFill(props: ComponentProps<typeof Kobalte.ProgressFill>) {
  return <Kobalte.ProgressFill data-slot="toast-progress-fill" {...props} />
}

export const Toast = Object.assign(ToastRoot, {
  Region: ToastRegion,
  Icon: ToastIcon,
  Content: ToastContent,
  Title: ToastTitle,
  Description: ToastDescription,
  Actions: ToastActions,
  CloseButton: ToastCloseButton,
  ProgressTrack: ToastProgressTrack,
  ProgressFill: ToastProgressFill,
})

export { toaster }

export type ToastVariant = "default" | "success" | "error" | "loading" | "subtle"

export interface ToastAction {
  label: string
  onClick: "dismiss" | (() => void)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: IconProps["name"]
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
  onDismiss?: () => void
}

export function showToast(options: ToastOptions | string) {
  const opts = typeof options === "string" ? { description: options } : options
  return toaster.show((props) => {
    // onCleanup runs when the toast root unmounts. That covers explicit dismiss
    // paths (close button, action click, swipe, escape, programmatic
    // toaster.dismiss) AND ambient unmounts (parent owner teardown, e.g. app
    // exit). For callers with "user-acknowledged" semantics (e.g. markSeen on
    // release notes), we gate onDismiss behind a flag set only by user-driven
    // dismiss handlers. Kobalte's swipe-end and escape paths call close()
    // directly without going through CloseButton's onClick, so they need
    // their own handlers — see <Toast> below. The fired guard is defense
    // against future Kobalte upgrades re-invoking this render closure.
    let userDismissed = false
    let fired = false
    const markUserDismissed = () => {
      userDismissed = true
    }
    if (opts.onDismiss) {
      onCleanup(() => {
        if (fired) return
        fired = true
        if (!userDismissed) return
        opts.onDismiss?.()
      })
    }
    return (
      <Toast
        toastId={props.toastId}
        duration={opts.duration}
        persistent={opts.persistent}
        data-variant={opts.variant ?? "default"}
        onSwipeEnd={markUserDismissed}
        onEscapeKeyDown={markUserDismissed}
      >
        <Show when={opts.icon}>
          <Toast.Icon name={opts.icon!} />
        </Show>
        <Toast.Content>
          <Show when={opts.title}>
            <Toast.Title>{opts.title}</Toast.Title>
          </Show>
          <Show when={opts.description}>
            <Toast.Description>{opts.description}</Toast.Description>
          </Show>
          <Show when={opts.actions?.length}>
            <Toast.Actions>
              {opts.actions!.map((action) => (
                <button
                  data-slot="toast-action"
                  onClick={() => {
                    markUserDismissed()
                    if (typeof action.onClick === "function") {
                      action.onClick()
                    }
                    toaster.dismiss(props.toastId)
                  }}
                >
                  {action.label}
                </button>
              ))}
            </Toast.Actions>
          </Show>
        </Toast.Content>
        <Toast.CloseButton onClick={markUserDismissed} />
      </Toast>
    )
  })
}

export interface ToastPromiseOptions<T, U = unknown> {
  loading?: JSX.Element
  success?: (data: T) => JSX.Element
  error?: (error: U) => JSX.Element
}

export function showPromiseToast<T, U = unknown>(
  promise: Promise<T> | (() => Promise<T>),
  options: ToastPromiseOptions<T, U>,
) {
  return toaster.promise(promise, (props) => (
    <Toast
      toastId={props.toastId}
      data-variant={props.state === "pending" ? "loading" : props.state === "fulfilled" ? "success" : "error"}
    >
      <Toast.Content>
        <Toast.Description>
          {props.state === "pending" && options.loading}
          {props.state === "fulfilled" && options.success?.(props.data!)}
          {props.state === "rejected" && options.error?.(props.error)}
        </Toast.Description>
      </Toast.Content>
      <Toast.CloseButton />
    </Toast>
  ))
}
