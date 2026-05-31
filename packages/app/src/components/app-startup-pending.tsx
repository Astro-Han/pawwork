import { Splash } from "@opencode-ai/ui/logo"

export function AppStartupPending() {
  return (
    <div
      data-component="app-startup-pending"
      role="status"
      aria-label="Opening PawWork"
      class="size-full bg-bg-base flex items-center justify-center"
    >
      <Splash class="w-12 h-15 opacity-50 animate-pulse" />
    </div>
  )
}
