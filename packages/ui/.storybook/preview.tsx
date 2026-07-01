import type { Preview } from "storybook-solidjs-vite"
import { MetaProvider } from "@solidjs/meta"
import { ThemeProvider } from "../src/theme/context"
import { MarkedProvider } from "../src/context/marked"
import { DialogProvider } from "../src/context/dialog"
import "../src/styles/tailwind/index.css"

const preview: Preview = {
  decorators: [
    (Story) => (
      <MetaProvider>
        <ThemeProvider defaultTheme="pawwork">
          <MarkedProvider>
            <DialogProvider>
              <Story />
            </DialogProvider>
          </MarkedProvider>
        </ThemeProvider>
      </MetaProvider>
    ),
  ],
}

export default preview
