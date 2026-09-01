# 爪印 PawWork

**免费、开源的桌面 AI 智能体，支持 macOS 和 Windows。基于 DeepSeek Harness（DSH）打包成一个完整产品——不用终端，不用 API Key，不用付费订阅。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[English](README.md) · [官网](https://pawwork.ai)

爪印把 DSH 的智能体运行时装配成一个可以直接交给普通人使用的桌面应用。免费模型、联网搜索、Office 文档能力都已经接好，第一次打开就是：选个文件夹，用大白话说要做什么。

它是 [Codex App](https://openai.com/codex/) 和 [Claude Cowork](https://www.anthropic.com/product/claude-cowork) 的开源替代——面向日常的文档、表格、资料整理和文件处理，而不只是浏览器里聊天或 IDE 里写代码。

![爪印 PawWork 的鲸鱼娘形象戴着橙色爪手套处理成摞的文档 - 开箱即用的桌面 AI 智能体](assets/readme/pawwork-cover.png)

## 爪印的差异在哪

基于 DeepSeek Harness 的桌面端项目已经很多，它们大多把同一件事做得很好：给已经在用 DSH 的开发者一个一键启动的方式，通常是打包一份 Node，再把官方 DSH Web UI 装进一个窗口里。

爪印想往外再走一步——面向那些根本不知道 DSH 是什么、也不该被要求去了解的人。

| | 爪印 PawWork | 常见的 DSH 桌面套壳 |
|---|---|---|
| 目标用户 | 不写代码的知识工作者 | 已经在用 DSH 的开发者 |
| 首次启动 | 内置免费模型，不需要 Key | 自备 API Key |
| 界面 | 原生 Electron 外壳——系统菜单、原生文件夹与文件选择器、原生更新 | 窗口里的官方 DSH Web UI |
| Office 文件 | 内置 `.docx` / `.xlsx` / `.pptx` / PDF 能力，附带 Python 工具链 | 不包含 |
| 定时任务 | Automations——按 cron 计划自动执行已保存的任务 | 不包含 |
| 打包分发 | macOS 已签名公证，Windows x64 安装包 | 常见只有单平台，且未签名 |

右侧一列是概括，具体项目各有不同，其中不少在自己的定位上做得很好。这张表说的是爪印占据的位置，不是排名。

因为底层跑的是真正的 DSH，这个定位不以牺牲生态为代价：社区的 DSH 插件可以直接在爪印里安装和运行。

## 产品对比

| | 爪印 PawWork | Codex App | Claude Desktop（Cowork） |
|---|---|---|---|
| 开源 | 是（Apache-2.0） | 否 | 否 |
| 免订阅可用 | 是（OpenCode Free） | 有限（ChatGPT Free） | 否（需 Pro，$20/月） |
| 桌面应用 | macOS + Windows | macOS + Windows | macOS + Windows |
| 本地文件访问 | 完整工作目录 | 默认沙箱 | 用户选定的文件夹 |
| Office 文件（Word/Excel/PPT） | 是 | 否 | 否 |
| 定时任务 | 是 | 否 | 否 |
| 插件生态 | DSH 插件 | 无 | MCP |

## 你可以让爪印做什么

### 文档与数据

- 把发票里的关键字段抽成一张可以逐笔核对的表格
- 读懂一个 CSV，写成一份简短报告
- 合并 PDF 并整理输出文件
- 把零散的笔记和附件整理成一份周报

### 调研与写作

- 对比几个产品页面，写一份决策备忘
- 搜索网页并整理某个主题的资料来源
- 把会议记录改写成一份公告初稿
- 把粗糙的素材改写得更清楚

### 代码与技术工作

- 读一个代码项目，说清楚该改什么
- review 一个 PR，把风险列出来
- 结合日志和源码排查一个 API 错误
- 用一句大白话需求做一个内部小工具

### 按计划自动执行

Automations 按 cron 计划自动执行已保存的任务——周一早上汇总某个文件夹、每晚导出、定期检查——结果直接写回你的工作目录。

## 怎么用

1. 选一个工作文件夹。
2. 用日常语言说清楚你想要什么。
3. 爪印会自行调用需要的文件、工具、模型和搜索。
4. 在采用结果前，你可以逐步查看它做了什么、产出了什么。

## 模型与搜索

爪印内置来自 OpenCode Free 的一批精选免费模型，以及联网搜索。不需要 API Key，也不需要购买模型订阅。如果你更想用自己的服务商，也可以在设置里配置。

免费模型列表在运行时从 [models.dev](https://models.dev) 目录刷新，目录不可达时回落到随包列表，所以应用内看到的模型可能在不更新版本的情况下发生变化。

## 下载

在 [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest) 下载最新的 macOS 和 Windows 版本。

- **macOS：** 下载 `.dmg`。正式版已由 Apple 签名并公证。
- **Windows：** 下载 Windows x64 的 `.exe`。当前为未签名安装包，首次打开可能弹出 SmartScreen——点「更多信息」，再点「仍要运行」。

爪印还很早期，迭代很快。每个版本的变化见发布说明。

## 项目组成

爪印 = DSH 运行时 + 原生桌面外壳 + 产品层。

- **运行时** —— 一组锁定版本的官方 `@deepseek-ai/dsh-*` 包（会话、工具、沙箱、上下文压缩、联网搜索、子智能体），在 sidecar 进程里装配，而不是去调 `dsh` CLI。
- **原生外壳** —— [`packages/desktop-electron/src/main`](packages/desktop-electron/src/main)：窗口装饰、应用菜单、原生目录与文件选择器、Windows 安装器加固、自动更新。
- **产品层** —— [`packages/desktop-electron/resources/dsh`](packages/desktop-electron/resources/dsh)：爪印自己维护的 DSH 插件，包括 OpenCode Free 模型路由、内置联网搜索、Automations、v1 设置迁移和桌面宿主桥接。
- **Skills** —— [`skills/`](skills)：随包的 Office skills，覆盖 `.docx`、`.xlsx`、`.pptx` 和 PDF，通过随包的 [`uv`](https://github.com/astral-sh/uv) Python 工具链执行，不依赖系统 Python。

## 从源码构建

需要 Node.js 24 和 pnpm 11。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
pnpm install --frozen-lockfile
pnpm dev:desktop
```

验证步骤、打包方式和贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 常见问题

**爪印是免费的吗？**
是。爪印采用 Apache-2.0 许可，内置免费模型和联网搜索，不需要 API Key 就能开始使用。

**爪印和 DeepSeek Harness 是什么关系？**
爪印用 DSH 作为智能体运行时。它是一个独立的开源产品：装配 DSH 的包，加上原生桌面外壳，再加上自己的插件来提供免费模型、联网搜索、Automations 和 Office 能力。与 DeepSeek 官方无隶属关系。

**爪印和其他 DSH 桌面端有什么不同？**
其他大多是面向已经在用 DSH、自备 API Key 的开发者的启动器。爪印面向不写代码的用户：内置免费模型，随包提供 Office 能力和 Python 工具链，外壳是原生的而不是把 Web UI 装进窗口，并且 macOS 已签名、Windows 也有安装包。

**能在爪印里用 DSH 插件吗？**
可以。底层是真正的 DSH，社区插件可以直接安装运行。

**爪印能处理本地文件吗？**
可以。爪印是原生桌面应用，能访问你选定的工作目录，在你的电脑上读写文档、表格、PDF、代码项目和产出文件。

**支持哪些文件格式？**
PDF、Word（`.docx`）、Excel（`.xlsx`）、PowerPoint（`.pptx`）、CSV、Markdown、纯文本、图片和代码文件。Office 文件在本地读写。

**能定时执行任务吗？**
可以。Automations 按 cron 计划执行已保存的任务，结果写回你的工作目录。

**能用自己的模型吗？**
可以。默认用内置免费模型，是为了让第一次使用不需要任何配置；你也可以在设置里配置自己的服务商。

**支持哪些平台？**
macOS（Apple 芯片与 Intel，已签名公证）和 Windows x64。

## 运行时与致谢

爪印基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建。同时感谢 OpenCode 项目与社区，以及 [Astral](https://github.com/astral-sh) 的 `uv`。

第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

[Apache License 2.0](LICENSE)
