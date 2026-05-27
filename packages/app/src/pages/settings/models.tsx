import { type Component } from "solid-js"
import { SettingsProviders } from "@/components/settings-providers"
import { SettingsModels } from "@/components/settings-models"

// 模型页（合并 提供商 + 模型，菜单显示「模型」/Models）。
// PR1 body 第一版：复用现有 SettingsProviders + SettingsModels 堆叠，功能对等先 ship。
// 后续按 docs/design/preview/settings-ai.html 的 master-detail 重写（左提供商列表 + 右模型列表 + 可见性开关），
// 复用 context/models.tsx 的 visible()/setVisibility()，不重造可见性规则。
export const ModelsPage: Component = () => {
  return (
    <div class="flex flex-col gap-8">
      <SettingsProviders />
      <SettingsModels />
    </div>
  )
}
