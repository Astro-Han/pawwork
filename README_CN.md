# 爪印 PawWork

**开箱即用的桌面 AI 智能体。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[English](README.md)

爪印 PawWork 是 Codex App 和 Claude Desktop 的开源替代方案。它面向真实的桌面工作场景，在一个极简、优雅的界面里，帮你处理文档、表格、资料整理、写作、代码和本地文件。

无需安装复杂的工具链，无需提前准备 API 密钥，也无需购买付费模型账号。爪印 PawWork 内置来自 OpenCode Zen 的免费额度、内置搜索和任务卡片，下载打开就能开始。

![爪印 PawWork - 开箱即用的桌面 AI 智能体](assets/readme/pawwork-cover.png)

## 为什么选择爪印 PawWork

爪印 PawWork 不是把聊天框换一个外壳，也不是只面向程序员的命令行工具。它想解决的是更常见的问题：你手里有文件、表格、资料、代码或一堆零散信息，希望 AI 智能体直接帮你推进工作。

- **少配置：** 下载应用，选择工作文件夹，就可以先用 OpenCode Zen 提供的免费额度开始。
- **处理真实桌面工作：** 面向本地文件、文档、表格、笔记、网页资料、代码和最终产物。
- **任务卡片：** 不从空白输入框开始，而是用具体任务帮你更快上手。
- **模型选择更多：** 支持 OpenAI、Claude、DeepSeek、Gemini、Kimi、GLM、OpenAI 兼容提供商，以及可用的 Coding Plan。
- **开源和可控：** 你可以查看它怎么工作，选择自己的工作文件夹，连接自己信任的账号，并在关键步骤继续前进行检查。

## 你可以让爪印 PawWork 做什么

### 文档和表格

- 从发票中提取关键信息，整理成可以检查的表格草稿
- 汇总一份 CSV，并生成简短报告
- 合并几份 PDF，并整理输出文件
- 根据会议记录和附件起草周报

### 资料和写作

- 对比几个产品页面，整理成决策建议
- 搜索网页资料，并保留可追溯来源
- 整理会议记录，起草公告草稿
- 改写零散素材，生成结构清晰的文档

### 代码和技术工作

- 看懂一个代码项目，并说明应该从哪里改
- 审查一个 PR，总结主要风险
- 结合日志和源码排查 API 报错
- 根据一句自然语言需求做一个小工具

## 工作方式

1. 选择一个工作文件夹。
2. 选择任务卡片，或直接用日常语言描述你想做什么。
3. 爪印 PawWork 根据任务调用文件、工具、模型和搜索。
4. 你检查执行步骤、输出内容和生成文件，再决定如何使用结果。

## 模型、账号和搜索

爪印 PawWork 内置来自 OpenCode Zen 的免费额度，也内置带免费额度的网页搜索。你不需要先准备自己的 API 密钥才能开始。

如果你需要更多模型选择或更强控制权，可以连接自己的模型账号。爪印 PawWork 支持 API 密钥，也支持可用提供商的 OAuth 登录、OpenAI 兼容提供商和可用的 Coding Plan，包括 OpenAI、Claude、DeepSeek、Gemini、Kimi、GLM 等。

## 下载

从 [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest) 下载最新的 macOS 和 Windows 版本。

- **macOS：** 下载 `.dmg`，release 构建已完成 Apple 签名和公证。
- **Windows：** 下载 Windows x64 `.exe`。该版本目前尚未签名，首次打开时可能会出现 SmartScreen 提示。

爪印 PawWork 还在快速迭代。每个版本的更新内容可以在发布说明中查看。

## 从源码运行

需要 [Bun](https://bun.sh) v1.2+。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
bun run dev:desktop
```

## 基于 OpenCode

爪印 PawWork 基于 [OpenCode](https://github.com/anomalyco/opencode) fork 构建。我们保留智能体底座，重建桌面产品体验，并加入爪印 PawWork 的任务入口、模型默认值和日常工作场景。

感谢 OpenCode 项目和社区。

爪印 PawWork 内置 iOfficeAI 的 [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)，用于在本地处理 Word、Excel 和 PowerPoint 文件。感谢 iOfficeAI 以 Apache-2.0 开源 OfficeCLI。

## License

[Apache License 2.0](LICENSE)
