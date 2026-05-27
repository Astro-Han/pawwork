import { type Component } from "solid-js"
import { SettingsProviders } from "@/components/settings-providers"
import { SettingsModels } from "@/components/settings-models"

// Models page (providers + models merged, shown as "Models" in the nav).
// First PR1 body: reuse the existing SettingsProviders + SettingsModels stacked, shipping at parity.
// Later rewrite as the master-detail in docs/design/preview/settings-ai.html (provider list on the
// left + model list on the right + visibility toggles), reusing context/models.tsx visible() /
// setVisibility() instead of re-inventing the visibility rules.
export const ModelsPage: Component = () => {
  return (
    <div class="flex flex-col gap-8">
      <SettingsProviders />
      <SettingsModels />
    </div>
  )
}
