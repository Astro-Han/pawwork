import { createJSXDecorator, type Preview } from "storybook-solidjs-vite"
import { UiPreviewProviders } from "../src/storybook/preview-providers"
import "../src/styles/tailwind/index.css"

const preview: Preview = {
  decorators: [
    createJSXDecorator((Story) => (
      <UiPreviewProviders>
        <Story />
      </UiPreviewProviders>
    )),
  ],
}

export default preview
