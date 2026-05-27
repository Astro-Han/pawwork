import { type Component } from "solid-js"
import { useLanguage } from "@/context/language"

// 集成页（MCP / 语言服务器 / 远程服务器 / 插件）。PR1 body 占位。
// TODO: 把 components/session/session-status-connections.tsx 的内容（服务器/MCP/LSP/插件 4 节 + Manage Servers）搬来，
// 同时删右侧栏 status tab 里的 Connections 区块 → 关 #862。
// 架构点：该组件用 session-scoped useSync()，搬进全局设置页需先确认数据源（是否换 useGlobalSync 之类），按分工可能要 Codex 把关。
export const IntegrationsPage: Component = () => {
  const language = useLanguage()
  return (
    <div class="flex flex-col gap-2 py-8">
      <h2 class="text-h2 text-fg-strong">{language.t("settings.tab.integrations")}</h2>
      <p class="text-body text-fg-weak">{language.t("settings.integrations.placeholder")}</p>
    </div>
  )
}
