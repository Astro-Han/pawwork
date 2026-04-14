# 爪印 PawWork

开箱即用的 AI 工作站。面向非技术知识工作者，内置工具链，下载即用。

**Status: v1.0 RELEASED** — 开源发布，GitHub public repo。

## Product

- 定位：AI 工作站，不是聊天机器人。CLI/API 是一等公民
- 目标用户：个体知识工作者（运营/客服/行政），不是程序员
- Day 1 用户：纯刻内部团队（20 人，已在用 OpenCode + 爪爪）
- 核心差异化（vs OpenCode / WorkBuddy）：
  1. **开箱即用**：工具内置，不需要 brew/pip/GitHub
  2. **知道做什么**：Show Case 卡片引导
  3. **一个入口搞定所有**：吸收爪爪内容能力 + 工具链
- 桌面端（Electron + SolidJS），GUI only
- 默认 Zen 免费模型（Minimax-M2.5），零配置。BYOK 作为进阶
- 开源客户端（MIT）

## Current State

- v1.0 已发布：https://github.com/Astro-Han/pawwork/releases/tag/v1.0.0
- 域名：pawwork.ai（Cloudflare Registrar，到期 2028-04）
- 品牌替换完成：Electron config、system prompts、i18n、logo/icons 全部 PawWork
- macOS .dmg (134MB) + Windows .exe (114MB) 可用
- Apple Developer ID 证书注册中（688元/年），等审核
- 纯刻团队仍在用原版 OpenCode（PawWork UI 还没重做）

## Next: UI 改造（来自 2026-04-14 团队反馈）

- 首页加场景卡片（解决"不知道能做什么"，WorkBuddy 的分类：文档处理/视频生成/深度研究/金融服务/数据分析/数据可视化/幻灯片/产品管理）
- 配色字体更美观（解决"太极客风"）
- 右侧面板从 git/diff 改为文件树 + 产物预览（git/diff 对非技术用户是负资产：郭进问"Git是什么"，张倩说"diff看起来像报错"）
- 详细反馈：docs/interviews/2026-04-14-WorkBuddy对比反馈.md

## Architecture

- OpenCode fork（Electron + SolidJS），MIT license，独立演化
- Session model：无目录锚点，每个对话独立，后端假装单目录 ~/PawWork/
- 差异化在 A 层（工具/prompt/默认值），不重写引擎机制
- 内置工具：officecli（docx/xlsx/pptx，29MB 原生二进制）
- Node.js 库：pdf-lib, pdfjs-dist, sharp（跑在 Electron Node 上）
- PATH 注入：`packages/opencode/src/tool/bash.ts` shellEnv() 自动将 tools 目录加入 PATH

## Permissions

- 默认全权限，deny list for dangerous bash ops
- 专用 trash 工具（跨平台，trash npm 包）
- 无权限弹窗

## Conventions

- Commit small, Conventional Commits (feat/fix/refactor/docs/chore), English
- Chinese for user-facing content, English for code, commits, and technical docs
- docs/SPEC.md is the product source of truth
- docs/ for design artifacts, interviews, and decisions (git excluded)
