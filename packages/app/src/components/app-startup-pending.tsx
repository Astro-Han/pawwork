import { Splash } from "@opencode-ai/ui/logo"
import { useLanguage } from "@/context/language"

export function AppStartupPending() {
  const language = useLanguage()

  return (
    <div
      data-component="app-startup-pending"
      role="status"
      aria-label={language.t("app.startup.opening")}
      class="size-full bg-bg-base flex items-center justify-center"
    >
      <Splash class="w-12 h-15 opacity-50 animate-pulse" />
    </div>
  )
}
