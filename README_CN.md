# 爪印 PawWork

**爪印是一个免费、开源的桌面 AI 智能体，支持 macOS 和 Windows，能处理文档、表格、研究、写作、代码等日常桌面工作。**

Codex App 和 Claude Cowork 的开源替代方案，内置免费模型，打开就能用。

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[English](README.md) · [官网](https://pawwork.ai)

爪印 PawWork 面向真实的桌面工作场景，在一个极简、优雅的界面里，帮你处理文档、表格、资料整理、写作、代码和本地文件。

无需安装复杂的工具链，无需提前准备 API 密钥，也无需购买付费模型账号。爪印 PawWork 内置来自 OpenCode Zen 的免费额度、内置搜索和任务卡片，下载打开就能开始。

![爪印 PawWork - 开箱即用的桌面 AI 智能体](assets/readme/pawwork-cover.png)

## 为什么选择爪印 PawWork

爪印 PawWork 不是把聊天框换一个外壳，也不是只面向程序员的命令行工具。它想解决的是更常见的问题：你手里有文件、表格、资料、代码或一堆零散信息，希望 AI 智能体直接帮你推进工作。

- **少配置：** 下载应用，选择工作文件夹，就可以先用 OpenCode Zen 提供的免费额度开始。
- **处理真实桌面工作：** 面向本地文件、文档、表格、笔记、网页资料、代码和最终产物。
- **任务卡片：** 不从空白输入框开始，而是用具体任务帮你更快上手。
- **内置免费模型：** 不用 API Key，也不用购买模型订阅。
- **开源和可控：** 你可以查看它怎么工作，选择自己的工作文件夹，并在关键步骤继续前进行检查。

## 产品对比

| | 爪印 PawWork | Codex App | Claude Desktop (Cowork) |
|---|---|---|---|
| 开源 | 是（Apache-2.0） | 否 | 否 |
| 免费无需订阅 | 有（OpenCode Zen） | 有限（ChatGPT Free） | 无（需 Pro $20/月） |
| 桌面应用 | macOS + Windows | macOS + Windows | macOS + Windows |
| 本地文件访问 | 完整工作区 | 默认沙箱 | 用户选择的文件夹 |
| Office 文件处理 | 支持（Word/Excel/PPT） | 不支持 | 不支持 |
| 面向非技术用户 | 是（任务卡片，无需终端） | 面向开发者 | 知识工作 + 编程 |

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

## 模型和搜索

爪印 PawWork 内置一组 OpenCode Free 免费模型和网页搜索。你不需要 API Key，也不用购买模型订阅。

## 下载

从 [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest) 下载最新的 macOS 和 Windows 版本。

- **macOS：** 下载 `.dmg`，release 构建已完成 Apple 签名和公证。
- **Windows：** 下载 Windows x64 `.exe`。该版本目前尚未签名，首次打开时可能会出现 SmartScreen 提示。

爪印 PawWork 还在快速迭代。每个版本的更新内容可以在发布说明中查看。

## 从源码运行

需要 Node.js 24 和 pnpm 11.7。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
pnpm install
pnpm dev:desktop
```

## 运行时与致谢

爪印 PawWork 使用 DeepSeek DSH 作为智能体运行时，外层只有 Electron 原生桌面壳与精简的 PawWork 产品层，负责日常工作流、迁移和 Automation。

感谢 OpenCode 项目和社区。

## 常见问题

**爪印 PawWork 免费吗？**
免费。爪印内置免费模型和网页搜索，下载打开就能用，不需要 API Key。

**支持哪些模型？**
爪印内置一组 OpenCode Free 免费模型。具体列表以应用内显示为准，并可能随版本更新。

**能处理本地文件吗？**
可以。爪印是桌面原生应用，对你选择的工作文件夹有完整的读写权限，可以处理文档、表格、PDF、代码项目和生成文件。

**支持哪些文件格式？**
PDF、Word (.docx)、Excel (.xlsx)、PowerPoint (.pptx)、CSV、Markdown、纯文本、图片和代码文件。Office 文件在你本地电脑上读写。

**支持哪些平台？**
macOS（Apple Silicon 和 Intel，已签名公证）和 Windows x64。

**是开源的吗？**
是，Apache-2.0 协议。可以在 [GitHub](https://github.com/Astro-Han/pawwork) 查看源码、从源码构建、参与贡献。

## License

[Apache License 2.0](LICENSE)
