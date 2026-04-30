# PawWork

**Open-source AI agent that works out of the box on your desktop.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md)

PawWork is an open-source alternative to Codex App and Claude Desktop. It brings AI agent work into a polished desktop app for files, documents, spreadsheets, research, writing, code, and local tasks.

Start without a terminal, API key, or paid model plan. PawWork includes a free plan powered by OpenCode Zen, built-in web search, task cards, and support for your own model accounts when you want more choice or control.

![PawWork - Open-source AI agent that works out of the box on your desktop](assets/readme/pawwork-cover.png)

## Why PawWork

PawWork is built for people who want AI agents to do real desktop work, not only chat in a browser or write code inside an IDE.

- **Less setup:** download the app, choose a workspace, and start with the included OpenCode Zen free plan.
- **Real desktop work:** work with local files, documents, spreadsheets, notes, web research, code, and generated outputs.
- **Task cards:** start from concrete tasks instead of a blank prompt.
- **Model choice:** connect OpenAI, Claude, DeepSeek, Gemini, Kimi, GLM, OpenAI-compatible providers, and supported coding plans.
- **Open-source control:** inspect the code, choose your workspace, connect the accounts you trust, and keep important actions reviewable.

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

## License

[Apache License 2.0](LICENSE)
