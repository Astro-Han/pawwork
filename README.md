# PawWork

**AI Agent for everyday work, made easy.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-supported-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-supported-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md)

---

PawWork is an open-source desktop AI agent for everyday work. It goes beyond chat by turning messy files, notes, spreadsheets, PDFs, and web research into reviewable files, reports, drafts, and decision memos you can use.

Open source, privacy-conscious, and ready to use on your desktop with the included free models.

## Ask PawWork to

- extract key fields from invoices into a reviewable spreadsheet draft
- summarize a CSV and create a report
- merge several PDFs and organize the output
- draft a weekly update from meeting notes and files
- compare product pages and prepare a decision memo
- inspect a code project and explain what to change

## Why PawWork Is Different

| What matters | PawWork | Typical closed agent apps |
|---|---|---|
| Getting started | Included free models. No API key, terminal, or setup required. | Easy to try, but often tied to one vendor account, credit system, or model. |
| Transparency | Open source. You can inspect how the app works and how it changes. | Product behavior depends on the vendor. |
| Privacy and control | You choose the workspace folder, use PawWork's free models or your own model account, and review important steps before continuing. | Data handling and automation rules depend on the vendor's platform. |
| Model choice | Start free, then connect your own model account when you want more control. | Usually optimized around the vendor's default model or credit system. |
| Real desktop work | Built for files, folders, spreadsheets, PDFs, notes, and local tasks. | Often starts as a broad chat or cloud task interface. |
| User guidance | Starts from concrete tasks so you do not have to invent prompts from scratch. | Often asks users to figure out what the agent should do. |
| Extensibility | Built around open skills and local tools that can grow with real work. | Extensions depend on the vendor roadmap. |

## How It Works

1. Choose a workspace folder.
2. Describe the task in everyday language.
3. Review the steps and use the result.

PawWork works through the task, shows progress, and helps produce files, reports, drafts, or decisions you can review.

## Current Focus

PawWork is focused on real desktop tasks: local files, documents, spreadsheets, writing, research, and small technical projects. New task skills and built-in tools are added around real user workflows.

## Download

Download the latest macOS and Windows builds from [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest). On macOS, download the `.dmg`. On Windows, download the `.exe`.

### macOS first launch

GitHub Releases builds go through Apple code signing and notarization in the release workflow.
If macOS shows a warning on first launch, right-click the app and select Open, or go to System Settings > Privacy & Security and click Open Anyway.

### Windows first launch

If Windows SmartScreen appears on first launch, click **More info** and then **Run anyway** for the downloaded release build.

## Build from Source

Requires [Bun](https://bun.sh) v1.2+.

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
cd packages/desktop-electron && bun run dev
```

## Credits

PawWork is a fork of [OpenCode](https://github.com/anomalyco/opencode). Thanks to the OpenCode project and community.

## License

[Apache License 2.0](LICENSE)
