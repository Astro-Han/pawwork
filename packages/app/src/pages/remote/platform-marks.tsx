import type { RemotePlatform } from "@/desktop-api-contract"

// Vendor logos keep their brand colors — the sanctioned exception to the
// one-icon-DNA chrome rule (docs/DESIGN.md: app/vendor marks stay on-brand).
// Hand-rolled (not in the Icon set). New platforms add a case to PlatformMark.

export function PlatformMark(props: { platform: RemotePlatform }) {
  switch (props.platform) {
    case "telegram":
      return <TelegramMark />
  }
}

/** The localized display-name key for a platform — a literal so `t()` stays typed. */
export function platformNameKey(platform: RemotePlatform) {
  switch (platform) {
    case "telegram":
      return "remote.platform.telegram" as const
  }
}

function TelegramMark() {
  return (
    <svg viewBox="0 0 24 24" class="size-5 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#229ED9" />
      <path
        fill="#fff"
        d="M5.6 11.8 16.5 7.6c.5-.2 1 .1.8.8l-1.85 8.74c-.14.62-.5.77-1.02.48l-2.82-2.08-1.36 1.31c-.15.15-.28.28-.57.28l.2-2.86 5.2-4.7c.23-.2-.05-.32-.35-.12l-6.43 4.05-2.77-.86c-.6-.19-.62-.6.13-.9z"
      />
    </svg>
  )
}
