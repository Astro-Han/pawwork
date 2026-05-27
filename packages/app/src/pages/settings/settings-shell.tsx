import { type Component, onCleanup, onMount } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tabs } from "@opencode-ai/ui/tabs"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneral } from "@/components/settings-general"
import { SettingsKeybinds } from "@/components/settings-keybinds"
import { SettingsMemory } from "@/components/settings-memory"
import { SettingsWorktrees } from "@/components/settings-worktrees"
import { ModelsPage } from "./models"
// 远程访问 / 集成：页面内容就绪前先不在 nav 露出（点进去只有占位，体验是空的）。
// 这俩要承接的连接管理目前仍在右侧栏 Connections 可用，功能不丢。文件保留待后续 PR 填充后放出。
// import { RemotePage } from "./remote"
// import { IntegrationsPage } from "./integrations"

// 两层 takeover 设置外壳：240 左 nav（扁平 7 项 + 返回应用行 + 版本 foot）+ 右内容。
// 替换旧 SettingsPage（components/settings-page.tsx）；旧 6 tab（含分开的 providers/models）→ 7 项，providers+models 合并为 models（显示「模型」）。
// 形态真值 docs/design/preview/settings-shell.{css,js} + settings-{general,ai,int}.html。
export type SettingsTab = "general" | "shortcuts" | "models" | "remote" | "integrations" | "worktrees" | "memory"

const TAB_VALUES: SettingsTab[] = ["general", "shortcuts", "models", "remote", "integrations", "worktrees", "memory"]

function isSettingsTab(value: string): value is SettingsTab {
  return (TAB_VALUES as string[]).includes(value)
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  )
}

export const SettingsShell: Component<{
  active: SettingsTab
  directory?: string
  onSelect: (value: SettingsTab) => void
  onClose: () => void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  let root: HTMLElement | undefined
  let returnFocus: HTMLElement | undefined

  onMount(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !root?.contains(active)) returnFocus = active
    if (!root) return
    const [first] = focusablesIn(root)
    first?.focus()

    // Escape 关闭设置：挂 document 而非靠 section 焦点冒泡（打开瞬间焦点未必落在壳内）。
    // 设置内若开着更上层 dialog（如连接服务商），让它先吃 Escape，不连带关掉整个设置。
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      // 设置内若开着 dialog（连接服务商等），让它先吃 Escape，不连带关设置
      if (document.querySelector('[data-component="dialog-overlay"]')) return
      event.preventDefault()
      props.onClose()
    }
    // capture 阶段：抢在全局 keybind/command 消费并 preventDefault 之前收到 Escape
    document.addEventListener("keydown", onEscape, true)
    onCleanup(() => document.removeEventListener("keydown", onEscape, true))
  })

  onCleanup(() => {
    const target = returnFocus
    returnFocus = undefined
    if (!target || !target.isConnected) return
    target.focus()
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !root) return
    if (event.key !== "Tab") return
    const focusables = focusablesIn(root)
    if (focusables.length === 0) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = !!active && root.contains(active)

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <section
      ref={(el) => (root = el)}
      data-component="settings-page"
      aria-label={language.t("sidebar.settings")}
      class="flex size-full min-h-0 bg-bg-base"
      onKeyDown={handleKeyDown}
    >
      <Tabs
        orientation="vertical"
        variant="settings"
        value={props.active}
        onChange={(value) => {
          if (!isSettingsTab(value)) return
          props.onSelect(value)
        }}
        class="h-full w-full"
      >
        <Tabs.List>
          <div class="flex h-full w-full flex-col justify-between">
            <div class="flex w-full flex-col gap-1.5 pt-3">
              <Button
                data-action="settings-back"
                variant="ghost"
                size="small"
                icon="arrow-left"
                onClick={props.onClose}
                class="w-full justify-start"
                aria-label={language.t("settings.backToApp")}
              >
                {language.t("settings.backToApp")}
              </Button>
              <div class="my-1 h-px bg-border-weaker" />
              <div class="flex w-full flex-col gap-1.5">
                <Tabs.Trigger value="general">
                  <Icon name="settings-gear" />
                  {language.t("settings.tab.general")}
                </Tabs.Trigger>
                <Tabs.Trigger value="shortcuts">
                  <Icon name="keyboard" />
                  {language.t("settings.tab.shortcuts")}
                </Tabs.Trigger>
                <Tabs.Trigger value="models">
                  <Icon name="models" />
                  {language.t("settings.tab.models")}
                </Tabs.Trigger>
                {/* 远程访问 / 集成页就绪前先不露出（见顶部 import 注释）
                <Tabs.Trigger value="remote">
                  <Icon name="remote-control" />
                  {language.t("settings.tab.remoteAccess")}
                </Tabs.Trigger>
                <Tabs.Trigger value="integrations">
                  <Icon name="plugin" />
                  {language.t("settings.tab.integrations")}
                </Tabs.Trigger>
                */}
                <Tabs.Trigger value="worktrees">
                  <Icon name="worktree" />
                  {language.t("settings.tab.worktrees")}
                </Tabs.Trigger>
                <Tabs.Trigger value="memory">
                  <Icon name="brain" />
                  {language.t("settings.tab.memory")}
                </Tabs.Trigger>
              </div>
            </div>

            <div class="flex flex-col gap-1 pl-1 py-1 text-h3 text-fg-weak">
              <span>{language.t("app.name.desktop")}</span>
              <span class="text-body">v{platform.version}</span>
            </div>
          </div>
        </Tabs.List>

        <Tabs.Content value="general" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsGeneral />
          </div>
        </Tabs.Content>
        <Tabs.Content value="shortcuts" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsKeybinds />
          </div>
        </Tabs.Content>
        <Tabs.Content value="models" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <ModelsPage />
          </div>
        </Tabs.Content>
        {/* 远程访问 / 集成页就绪前先不露出（见顶部 import 注释）
        <Tabs.Content value="remote" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <RemotePage />
          </div>
        </Tabs.Content>
        <Tabs.Content value="integrations" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <IntegrationsPage />
          </div>
        </Tabs.Content>
        */}
        <Tabs.Content value="worktrees" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsWorktrees />
          </div>
        </Tabs.Content>
        <Tabs.Content value="memory" class="no-scrollbar">
          <div class="mx-auto w-full max-w-[760px]">
            <SettingsMemory directory={props.directory} />
          </div>
        </Tabs.Content>
      </Tabs>
    </section>
  )
}
