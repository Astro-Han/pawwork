# PawWork

**PawWork is a free, open-source desktop AI agent for macOS and Windows that handles documents, spreadsheets, research, writing, code, and local file tasks.**

Open-source alternative to [Codex App](https://openai.com/codex/) and [Claude Cowork](https://www.anthropic.com/product/claude-cowork), with free models ready to use.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md) · [Website](https://pawwork.ai)

PawWork brings AI agent work into a polished desktop app for files, documents, spreadsheets, research, writing, code, and local tasks. Open the app, choose a workspace, and start with the included OpenCode Free models.

![PawWork - Open-source alternative to Codex App and Claude Cowork](assets/readme/pawwork-cover.png)

## Why PawWork

PawWork is built for people who want AI agents to do real desktop work, not only chat in a browser or write code inside an IDE.

- **Less setup:** download the app, choose a workspace, and start with the included OpenCode Zen free plan.
- **Real desktop work:** work with local files, documents, spreadsheets, notes, web research, code, and generated outputs.
- **Task cards:** start from concrete tasks instead of a blank prompt.
- **Free models included:** start without an API key or paid model subscription.
- **Open-source control:** inspect the code, choose your workspace, and keep important actions reviewable.

## How PawWork Compares

| | PawWork | Codex App | Claude Desktop (Cowork) |
|---|---|---|---|
| Open-source | Yes (Apache-2.0) | No | No |
| Free without subscription | Yes (OpenCode Zen) | Limited (ChatGPT Free) | No (Pro $20/mo required) |
| Desktop app | macOS + Windows | macOS + Windows | macOS + Windows |
| Local file access | Full workspace access | Sandboxed by default | User-selected folders |
| Office files (Word/Excel/PPT) | Yes | No | No |
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

## Models and Search

PawWork includes curated free models through OpenCode Free, plus built-in web search. You can start without an API key or paid model subscription.

## Download

Download the latest macOS and Windows builds from [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest).

- **macOS:** download the `.dmg`. Release builds are signed and notarized by Apple.
- **Windows:** download the Windows x64 `.exe`. Windows builds are available and currently unsigned, so SmartScreen may appear on first launch.

PawWork is early and moving fast. Release notes describe what changed in each build.

## Build From Source

Requires Node.js 24 and pnpm 11.7.

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
pnpm install
pnpm dev:desktop
```

## Runtime and acknowledgements

PawWork uses DeepSeek DSH as its agent runtime, wrapped by a native Electron desktop shell and a small PawWork product layer for everyday workflows, migration, and Automation.

Thanks to the OpenCode project and community.

## FAQ

**Is PawWork free?**
Yes. PawWork includes free models and built-in web search. You can start without an API key.

**What models does PawWork support?**
PawWork ships a curated set of OpenCode Free models. The available list is shown in the app and may change between releases.

**Does PawWork work with local files?**
Yes. PawWork runs as a native desktop app with full access to your local workspace. It can read and write documents, spreadsheets, PDFs, code projects, and generated output files.

**What file formats does PawWork handle?**
PawWork works with PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, Markdown, plain text, images, and code files. Office files are read and written locally on your machine.

**What platforms does PawWork support?**
macOS (Apple Silicon and Intel, signed and notarized) and Windows x64.

**Is PawWork open-source?**
Yes. PawWork is licensed under Apache-2.0. You can inspect the code, build from source, and contribute on [GitHub](https://github.com/Astro-Han/pawwork).

## License

[Apache License 2.0](LICENSE)
