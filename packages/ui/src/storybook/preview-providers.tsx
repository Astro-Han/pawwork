import type { ParentProps } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { ThemeProvider } from "../theme/context"
import { DialogProvider } from "../context/dialog"
import { MarkedProvider } from "../context/marked"

/**
 * Minimal provider stack for Storybook previews.
 *
 * Mirrors the app nesting order (`Meta > Theme > Dialog > Marked`) so that
 * components relying on `useDialog` inside markdown-rendered content resolve
 * the same context as in production. `FileComponentProvider` is intentionally
 * omitted: no standalone UI story renders file content, and wiring it would
 * require an app-level `File` component that does not belong in the ui package.
 */
export function UiPreviewProviders(props: ParentProps) {
  return (
    <MetaProvider>
      <ThemeProvider defaultTheme="pawwork">
        <DialogProvider>
          <MarkedProvider>{props.children}</MarkedProvider>
        </DialogProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}