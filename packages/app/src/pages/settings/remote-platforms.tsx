import { Show, type Component } from "solid-js"
import type { Dictionary } from "@/context/language"
import { PLATFORM_ICONS } from "./remote-platform-icons"

export type FieldKind = "text" | "secret" | "switch"

export type PlatformField = {
  key: string
  kind: FieldKind
  required?: boolean
  defaultValue?: string
}

const field = (key: string, kind: FieldKind, required = false, defaultValue?: string): PlatformField => ({
  key,
  kind,
  required,
  defaultValue,
})

// Per-platform option schemas follow the bridge contract verified in
// packages/remote-bridge/internal/platforms/platforms_test.go. QQ also exposes
// its OneBot connection fields (ws_url / token / http_url), which the contract
// test omits because they fall back to a local default.
export const PLATFORM_FIELDS: Record<string, PlatformField[]> = {
  feishu: [
    field("app_id", "text", true),
    field("app_secret", "secret", true),
    field("allow_chat", "text"),
    field("group_only", "switch"),
  ],
  lark: [
    field("app_id", "text", true),
    field("app_secret", "secret", true),
    field("allow_chat", "text"),
    field("group_only", "switch"),
  ],
  slack: [field("bot_token", "secret", true), field("app_token", "secret", true), field("allow_from", "text")],
  discord: [field("token", "secret", true), field("allow_from", "text")],
  telegram: [field("token", "secret", true), field("allow_from", "text")],
  line: [field("channel_secret", "secret", true), field("channel_token", "secret", true), field("allow_from", "text")],
  weixin: [field("token", "secret", true), field("allow_from", "text")],
  qq: [
    field("ws_url", "text", true, "ws://127.0.0.1:3001"),
    field("token", "secret"),
    field("http_url", "text"),
    field("allow_from", "text"),
  ],
  qqbot: [field("app_id", "text", true), field("app_secret", "secret", true), field("allow_from", "text")],
  dingtalk: [field("client_id", "text", true), field("client_secret", "secret", true), field("allow_from", "text")],
  wecom: [
    field("mode", "text"),
    field("bot_id", "text", true),
    field("bot_secret", "secret", true),
    field("allow_from", "text"),
  ],
  "wps-xiezuo": [field("app_id", "text", true), field("app_secret", "secret", true), field("allow_from", "text")],
  max: [field("token", "secret", true), field("allow_from", "text")],
}

// Preferred display order; the grid still only shows what the bridge reports as available.
export const PLATFORM_ORDER = [
  "feishu",
  "lark",
  "slack",
  "discord",
  "telegram",
  "line",
  "weixin",
  "qq",
  "qqbot",
  "dingtalk",
  "wecom",
  "wps-xiezuo",
  "max",
]

export const PLATFORM_NAME: Record<string, keyof Dictionary> = {
  feishu: "settings.remote.platform.feishu",
  lark: "settings.remote.platform.lark",
  slack: "settings.remote.platform.slack",
  discord: "settings.remote.platform.discord",
  telegram: "settings.remote.platform.telegram",
  line: "settings.remote.platform.line",
  weixin: "settings.remote.platform.weixin",
  qq: "settings.remote.platform.qq",
  qqbot: "settings.remote.platform.qqbot",
  dingtalk: "settings.remote.platform.dingtalk",
  wecom: "settings.remote.platform.wecom",
  "wps-xiezuo": "settings.remote.platform.wps-xiezuo",
  max: "settings.remote.platform.max",
}

export const FIELD_LABEL: Record<string, keyof Dictionary> = {
  app_id: "settings.remote.field.app_id",
  app_secret: "settings.remote.field.app_secret",
  client_id: "settings.remote.field.client_id",
  client_secret: "settings.remote.field.client_secret",
  token: "settings.remote.field.token",
  channel_secret: "settings.remote.field.channel_secret",
  channel_token: "settings.remote.field.channel_token",
  bot_token: "settings.remote.field.bot_token",
  app_token: "settings.remote.field.app_token",
  bot_id: "settings.remote.field.bot_id",
  bot_secret: "settings.remote.field.bot_secret",
  mode: "settings.remote.field.mode",
  ws_url: "settings.remote.field.ws_url",
  http_url: "settings.remote.field.http_url",
  allow_from: "settings.remote.field.allow_from",
  allow_chat: "settings.remote.field.allow_chat",
  group_only: "settings.remote.field.group_only",
}

// Hints only where the field needs explaining; credential fields stand on their own.
export const FIELD_HINT: Partial<Record<string, keyof Dictionary>> = {
  allow_from: "settings.remote.field.allow_from.hint",
  allow_chat: "settings.remote.field.allow_chat.hint",
  group_only: "settings.remote.field.group_only.hint",
  mode: "settings.remote.field.mode.hint",
  ws_url: "settings.remote.field.ws_url.hint",
  http_url: "settings.remote.field.http_url.hint",
}

export const PlatformLogo: Component<{ platform: string; size?: number }> = (props) => {
  const icon = () => PLATFORM_ICONS[props.platform]
  const size = () => props.size ?? 28
  return (
    <Show
      when={icon()}
      fallback={
        <div
          class="flex items-center justify-center rounded-md bg-bg-cream font-medium text-fg-weak uppercase"
          style={{ width: `${size()}px`, height: `${size()}px`, "font-size": `${Math.round(size() * 0.42)}px` }}
        >
          {props.platform.charAt(0)}
        </div>
      }
    >
      {(ic) => (
        <svg
          width={size()}
          height={size()}
          viewBox={ic().viewBox}
          fill="currentColor"
          style={ic().color ? { color: ic().color } : undefined}
          innerHTML={ic().body}
          aria-hidden="true"
        />
      )}
    </Show>
  )
}
