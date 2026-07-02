import { createJSXDecorator, type Preview } from "storybook-solidjs-vite"
import { MetaProvider } from "@solidjs/meta"
import { ThemeProvider } from "../src/theme/context"
import { DialogProvider } from "../src/context/dialog"
import { MarkedProvider } from "../src/context/marked"
import "../src/styles/tailwind/index.css"

// Mirrors the app nesting order (Meta > Theme > Dialog > Marked) so components
// relying on useDialog inside markdown-rendered content resolve the same
// context as in production. FileComponentProvider is omitted: no standalone UI
// story renders file content, and wiring it would require an app-level File
// component that does not belong in the ui package.
const preview: Preview = {
  decorators: [
    createJSXDecorator((Story) => (
      <MetaProvider>
        <ThemeProvider defaultTheme="pawwork">
          <DialogProvider>
            <MarkedProvider>
              <Story />
            </MarkedProvider>
          </DialogProvider>
        </ThemeProvider>
      </MetaProvider>
    )),
  ],
}

export default preview