# 爪印 PawWork

**让每个人都能用的日常工作 AI Agent。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-supported-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[English](README.md)

---

PawWork 是一个面向日常工作的开源桌面 AI Agent。它不只是聊天，而是帮你把零散文件、笔记、表格、PDF 和网页资料整理成可以检查和使用的文件、报告、草稿和决策建议。

开源、更重视隐私和控制，内置免费模型，下载到电脑上即可开始。

## 你可以让 PawWork

- 把发票里的关键信息整理成一份可检查的表格草稿
- 汇总一份 CSV，并生成报告
- 合并几份 PDF，并整理输出文件
- 根据会议记录和附件起草周报
- 对比几个产品页面，并整理成决策建议
- 检查一个代码项目，并说明该改哪里

## PawWork 有什么不同

| 你关心的事 | PawWork | 常见闭源 Agent 应用 |
|---|---|---|
| 开始使用 | 内置免费模型，不需要 API Key、不需要终端、不需要配置。 | 通常也容易试用，但往往绑定某个厂商账号、积分体系或默认模型。 |
| 透明度 | 开源。你可以查看应用如何工作、如何变化。 | 产品行为取决于厂商。 |
| 隐私和控制 | 你选择工作文件夹，使用 PawWork 免费模型或自己的模型账号，并在继续前查看关键步骤。 | 数据处理和自动化规则取决于厂商平台。 |
| 模型选择 | 先免费使用；需要更多控制权时，可以接入自己的模型账号。 | 通常围绕厂商默认模型或积分系统优化。 |
| 真实桌面工作 | 围绕文件夹、表格、PDF、笔记和本地任务设计。 | 很多产品从宽泛聊天或云端任务入口开始。 |
| 上手引导 | 从具体任务开始，不需要用户自己琢磨怎么写提示词。 | 经常需要用户自己想清楚要让 Agent 做什么。 |
| 可扩展性 | 基于开放 Skill 和本地工具，可以随着真实工作继续扩展。 | 扩展能力取决于厂商路线图。 |

## 它怎么工作

1. 选择工作文件夹。
2. 用日常语言描述任务。
3. 查看步骤并使用结果。

PawWork 会一步步执行任务，展示进展，并帮你生成可以检查和使用的文件、报告、草稿或决策建议。

## 当前重点

PawWork 聚焦真实桌面任务：本地文件、文档、表格、写作、资料整理和小型技术项目。新的任务 Skill 和内置工具会围绕真实用户工作流持续增加。

## 下载

从 [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest) 下载最新的 macOS 和 Windows 版本。macOS 下载 `.dmg`，Windows 下载 `.exe`。

### macOS 首次打开

GitHub Releases 提供的构建会经过 Apple 签名和公证。
如果首次打开时 macOS 弹出警告，请右键点击应用并选择“打开”，或者前往“系统设置 > 隐私与安全性”点击“仍要打开”。

### Windows 首次打开

如果 Windows SmartScreen 在首次打开时出现，请点击“更多信息”，然后对下载的 release 构建选择“仍要运行”。

## 从源码构建

需要 [Bun](https://bun.sh) v1.2+。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
cd packages/desktop-electron && bun run dev
```

## 致谢

PawWork fork 自 [OpenCode](https://github.com/anomalyco/opencode)。感谢 OpenCode 项目和社区。

## License

[Apache License 2.0](LICENSE)
