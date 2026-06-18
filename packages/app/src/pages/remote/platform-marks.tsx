import type { RemotePlatform } from "@/desktop-api-contract"

// Vendor logos keep their brand colors — the sanctioned exception to the
// one-icon-DNA chrome rule (docs/DESIGN.md: app/vendor marks stay on-brand).
// Hand-rolled (not in the Icon set) the way the Telegram mark already was.

export function PlatformMark(props: { platform: RemotePlatform }) {
  return (
    <>
      {props.platform === "telegram" && <TelegramMark />}
      {props.platform === "feishu" && <FeishuMark />}
      {props.platform === "wechat" && <WeChatMark />}
    </>
  )
}

/** The localized display-name key for a platform — a literal so `t()` stays typed. */
export function platformNameKey(platform: RemotePlatform) {
  switch (platform) {
    case "telegram":
      return "remote.platform.telegram" as const
    case "feishu":
      return "remote.platform.feishu" as const
    case "wechat":
      return "remote.platform.wechat" as const
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

function FeishuMark() {
  return (
    <svg viewBox="0 0 48 48" class="size-5 shrink-0" aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="#3370FF" />
      <path fill="#fff" d="M14 16h13c5 0 8 3 8 7 0 3-2 6-6 7l5 6h-6l-5-6h-4v6h-5V16zm5 4v6h7c2 0 3-1 3-3s-1-3-3-3h-7z" />
    </svg>
  )
}

function WeChatMark() {
  return (
    <svg viewBox="0 0 48 48" class="size-5 shrink-0" aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="#07C160" />
      <path
        fill="#fff"
        d="M19 13c-6 0-11 4-11 9 0 3 2 5 4 7l-1 4 4-2c1 .3 3 .5 4 .5h1c-.5-1-.7-2-.7-3 0-5 5-9 11-9h1c-1-4-6-6.5-12-6.5zm-4 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm9 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"
      />
      <path
        fill="#fff"
        d="M40 28c0-4-4-7-9-7s-9 3-9 7 4 7 9 7c1 0 2 0 3-.4l3 1.4-.8-3c1.7-1.3 2.8-3 2.8-5zm-12-2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zm6 0a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"
      />
    </svg>
  )
}
