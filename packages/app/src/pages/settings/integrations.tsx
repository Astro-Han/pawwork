import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

// Integrations page (MCP / language servers / remote servers / plugins). PR1 body is a placeholder.
// TODO: move the content of components/session/session-status-connections.tsx (servers / MCP / LSP /
// plugins sections + Manage Servers) here, and drop the Connections block from the right-panel status
// tab -> closes #862.
// Architecture note: that component uses a session-scoped useSync(); moving it into the global settings
// page needs the data source settled first (e.g. switching to a useGlobalSync), likely worth a Codex review.
export const IntegrationsPage: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2 py-8">
      <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.integrations")}</h2>
      <p class="text-body text-fg-weak">{language.t("settings.integrations.placeholder")}</p>
    </div>
  )
}
