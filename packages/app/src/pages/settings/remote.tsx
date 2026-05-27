import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

// 远程访问页。PR1 body 占位：保证菜单点了不空、整体可上线。
// 后续迁入远程服务器连接 / 管理（原 Connections 的服务器部分 + Manage Servers）真功能。
export const RemotePage: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2 py-8">
      <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.remoteAccess")}</h2>
      <p class="text-body text-fg-weak">{language.t("settings.remote.placeholder")}</p>
    </div>
  )
}
