import { createSignal, onMount, Show, type Accessor } from "solid-js"
import { Portal } from "solid-js/web"

export function PawworkTitlebar(props: { visible: Accessor<boolean>; title: Accessor<string> }) {
  const [centerMount, setCenterMount] = createSignal<HTMLElement>()

  onMount(() => {
    setCenterMount(document.getElementById("pawwork-titlebar-center") ?? undefined)
  })

  return (
    <Show when={props.visible() && centerMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div class="hidden md:flex min-w-0 items-center gap-1.5 text-13-medium">
            <div class="min-w-0 truncate text-text-strong">{props.title()}</div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
