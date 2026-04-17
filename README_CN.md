# 爪印 PawWork

**处理文档、分析数据、起草内容。不需要 API Key，不需要命令行，不需要任何配置。**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[English](README.md)

---

PawWork 是一个桌面应用，让知识工作者用 AI 直接处理手头的工作，而不只是聊天。下载，打开，开始干活。

<!-- TODO: 添加截图 -->

## 能做什么

- **Office 文档** — 创建和编辑 Word (.docx)、Excel (.xlsx)、PowerPoint (.pptx)，不需要安装 Office
- **数据分析** — 拖入表格或 CSV，获得汇总、图表和报告
- **写作辅助** — 从零散笔记起草邮件、周报、方案、通知
- **PDF 处理** — 合并、拆分、提取、转换 PDF 文件

所有工具都内置在应用里。不需要安装任何东西，不需要终端，不需要包管理器。

## 下载

macOS (Apple Silicon): **[下载 .dmg](https://github.com/Astro-Han/pawwork/releases/latest)**

### macOS 首次打开

PawWork 暂未完成 Apple 签名。首次打开时：
右键点击应用 > 打开 > 在弹窗中确认「打开」。

## 适合谁用

PawWork 是为每天跟文档、表格、写作打交道，但不想学编程或管理 API Key 的人设计的。如果你用过 ChatGPT 或 Claude，但希望 AI 能直接在你电脑上处理文件，PawWork 就是为你做的。

## 从源码构建

需要 [Bun](https://bun.sh) v1.2+。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
cd packages/desktop-electron && bun run dev
```

## 致谢

PawWork fork 自 [OpenCode](https://github.com/anomalyco/opencode)，有修改。

## License

[Apache License 2.0](LICENSE)
