import { batch, type Accessor, type Setter } from "solid-js"
import { useModels, type ModelKey } from "@/context/models"
import type { ModelPickerState } from "@/components/prompt-input/model-picker"

// Panel-local model controller for the Automations create card. The surface
// renders outside the per-directory LocalProvider, so the composer's
// useLocal-backed model state can't be reused; this drives the same picker UI
// from useModels() (the global provider list) plus dialog-local model/variant
// signals. Switching models clears the variant, since thinking levels are
// model-specific and the create card holds a single throwaway selection.
export function createAutomationModelState(input: {
  models: ReturnType<typeof useModels>
  model: Accessor<ModelKey | undefined>
  setModel: Setter<ModelKey | undefined>
  variant: Accessor<string | undefined>
  setVariant: Setter<string | undefined>
}): ModelPickerState {
  const { models } = input
  const current = () => {
    const key = input.model()
    return key ? models.find(key) : undefined
  }
  return {
    list: models.list,
    current,
    visible: (item) => models.visible(item),
    set: (item) =>
      batch(() => {
        input.setModel(item)
        input.setVariant(undefined)
        if (item) models.setVisibility(item, true)
      }),
    variant: {
      list: () => Object.keys(current()?.variants ?? {}),
      current: () => input.variant(),
      set: (value) => input.setVariant(value),
    },
  }
}
