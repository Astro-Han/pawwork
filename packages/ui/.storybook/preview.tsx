import type { Preview } from "storybook-solidjs-vite"
import { ThemeProvider } from "../src/theme/context"
import { MarkedProvider } from "../src/context/marked"
import "../src/styles/tailwind/index.css"

const preview: Preview = {
  decorators: [
    (Story) => (
      <ThemeProvider defaultTheme="pawwork">
        <MarkedProvider>
          <Story />
        </MarkedProvider>
      </ThemeProvider>
    ),
  ],
}

export default preview
