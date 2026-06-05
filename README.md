# PawWork

**PawWork is a free, open-source desktop AI agent for macOS and Windows that handles documents, spreadsheets, research, writing, code, and local file tasks using 75+ AI model providers.**

Open-source alternative to [Codex App](https://openai.com/codex/) and [Claude Cowork](https://www.anthropic.com/product/claude-cowork). Bring your own key. Works with any model — including ChatGPT OAuth.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md) · [Website](https://pawwork.ai)

PawWork brings AI agent work into a polished desktop app for files, documents, spreadsheets, research, writing, code, and local tasks. Use your ChatGPT Plus/Pro plan via OAuth, or bring your own API key for OpenAI, Claude, Gemini, DeepSeek, Kimi, GLM, and 75+ providers, including local models.

![PawWork - Open-source alternative to Codex App and Claude Cowork](assets/readme/pawwork-cover.png)

## Why PawWork

PawWork is built for people who want AI agents to do real desktop work, not only chat in a browser or write code inside an IDE.

- **Less setup:** download the app, choose a workspace, and start with the included OpenCode Zen free plan.
- **Real desktop work:** work with local files, documents, spreadsheets, notes, web research, code, and generated outputs.
- **Task cards:** start from concrete tasks instead of a blank prompt.
- **Model choice:** connect OpenAI, Claude, DeepSeek, Gemini, Kimi, GLM, OpenAI-compatible providers, and supported coding plans.
- **Open-source control:** inspect the code, choose your workspace, connect the accounts you trust, and keep important actions reviewable.

## How PawWork Compares

| | PawWork | Codex App | Claude Desktop (Cowork) |
|---|---|---|---|
| Open-source | Yes (Apache-2.0) | No | No |
| Bring your own key | Yes, 75+ providers | OpenAI only | Anthropic only (gateway for others) |
| ChatGPT OAuth | Yes | No | No |
| Free without subscription | Yes (OpenCode Zen) | Limited (ChatGPT Free) | No (Pro $20/mo required) |
| Desktop app | macOS + Windows | macOS + Windows | macOS + Windows |
| Local file access | Full workspace access | Sandboxed by default | User-selected folders |
| Local models | Yes (Ollama, LM Studio, etc.) | CLI only (Ollama) | Via gateway (Requesty) |
| Office files (Word/Excel/PPT) | Yes (via OfficeCLI) | No | No |
| Non-technical user focus | Yes (task cards, no terminal) | Developer-focused | Knowledge work + coding |

## What You Can Ask PawWork To Do

### Documents and Data

- extract key fields from invoices into a reviewable spreadsheet draft
- summarize a CSV and create a short report
- merge PDFs and organize the output files
- turn messy notes and attachments into a weekly update

### Research and Writing

- compare product pages and prepare a decision memo
- search the web and collect sources for a topic
- turn meeting notes into a draft announcement
- rewrite rough material into a clearer document

### Code and Technical Work

- inspect a code project and explain what to change
- review a pull request and summarize the risks
- debug an API error with logs and source files
- build a small internal tool from a plain-language request

## How It Works

1. Choose a workspace folder.
2. Pick a task card or describe what you want in everyday language.
3. Let PawWork work with the files, tools, models, and search it needs.
4. Review the steps, outputs, and files before you use the result.

## Models, Plans, and Search

PawWork includes a free plan powered by OpenCode Zen, plus built-in web search with a free quota. You can start without bringing your own API key.

When you want more model choice or control, connect your own accounts. PawWork supports API keys, OAuth where available, OpenAI-compatible providers, and supported coding plans, including OpenAI, Claude, DeepSeek, Gemini, Kimi, GLM, and more.

## Download

Download the latest macOS and Windows builds from [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest).

- **macOS:** download the `.dmg`. Release builds are signed and notarized by Apple.
- **Windows:** download the Windows x64 `.exe`. Windows builds are available and currently unsigned, so SmartScreen may appear on first launch.

PawWork is early and moving fast. Release notes describe what changed in each build.

## Build From Source

Requires [Bun](https://bun.sh) v1.2+.

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
bun run dev:desktop
```

## Built on OpenCode

PawWork is built on a fork of [OpenCode](https://github.com/anomalyco/opencode). We keep the agent engine, rebuild the desktop product experience, and add PawWork-specific workflows, model defaults, and everyday-work entry points.

Thanks to the OpenCode project and community.

PawWork bundles [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI) by iOfficeAI to handle Word, Excel, and PowerPoint files locally. Thanks to iOfficeAI for the Apache-2.0 open-source OfficeCLI project.

## FAQ

**Is PawWork free?**
Yes. PawWork includes a free plan powered by OpenCode Zen with built-in web search. You can start without an API key. For more model choice, connect your own accounts.

**What models does PawWork support?**
OpenAI (including ChatGPT Plus/Pro via OAuth), Claude, DeepSeek, Gemini, Kimi, GLM, and any OpenAI-compatible provider — over 75 providers total, including local models via Ollama and LM Studio.

**Does PawWork work with local files?**
Yes. PawWork runs as a native desktop app with full access to your local workspace. It can read and write documents, spreadsheets, PDFs, code projects, and generated output files.

**What file formats does PawWork handle?**
PawWork works with PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, Markdown, plain text, images, and code files. Office file handling is powered by the bundled OfficeCLI.

**What platforms does PawWork support?**
macOS (Apple Silicon and Intel, signed and notarized) and Windows x64.

**Is PawWork open-source?**
Yes. PawWork is licensed under Apache-2.0. You can inspect the code, build from source, and contribute on [GitHub](https://github.com/Astro-Han/pawwork).

## License

[Apache License 2.0](LICENSE)
