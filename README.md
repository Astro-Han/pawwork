# PawWork

**A free, open-source desktop AI agent for macOS and Windows, built on DeepSeek Harness (DSH) and packaged as a finished product — no terminal, no API key, no paid plan.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-signed_and_notarized-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)
[![Windows](https://img.shields.io/badge/Windows_x64-unsigned-blue.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md) · [Website](https://pawwork.ai)

PawWork turns a DSH agent runtime into a desktop application you could hand to someone who has never opened a terminal. It ships with free models, built-in web search, and Office document skills already wired up, so the first run is: open the app, choose a folder, describe the work in plain language.

It is an open alternative to [Codex App](https://openai.com/codex/) and [Claude Cowork](https://www.anthropic.com/product/claude-cowork) — for everyday document, spreadsheet, research, and file work, not only browser chat or IDE coding.

![PawWork's whale-girl mascot in orange paw gloves working through a stack of documents - open-source alternative to Codex App and Claude Cowork](assets/readme/pawwork-cover.webp)

## What Makes PawWork Different

There are many DeepSeek Harness desktop apps. Most of them solve one problem well: giving a developer who already uses DSH a one-click way to launch it, usually by bundling Node and loading the official DSH web UI in a window.

PawWork aims one step further out — at the person who does not know what DSH is and should not have to learn.

| | PawWork | Common DSH desktop wrapper |
|---|---|---|
| Intended user | Non-technical knowledge worker | Developer who already runs DSH |
| First launch | Free models included, no key needed | Bring your own API key |
| Interface | Native Electron shell — OS menus, native folder and file pickers, native updater | Official DSH web UI in a window |
| Office files | Bundled `.docx` / `.xlsx` / `.pptx` / PDF skills with a bundled Python toolchain | Not included |
| Scheduled work | Automations — run a saved task on a cron schedule | Not included |
| Packaging | macOS signed and notarized, Windows x64 installer | Often single-platform, often unsigned |

The right-hand column is a generalization; individual projects differ, and several are excellent at what they set out to do. The point is the position PawWork occupies, not a ranking.

Because the runtime underneath is real DSH, this is not a trade-off against the ecosystem: DSH plugins from the wider community install and run inside PawWork.

## How PawWork Compares

| | PawWork | Codex App | Claude Desktop (Cowork) |
|---|---|---|---|
| Open-source | Yes (Apache-2.0) | No | No |
| Free without subscription | Yes (OpenCode Free) | Limited (ChatGPT Free) | No (Pro $20/mo required) |
| Desktop app | macOS + Windows | macOS + Windows | macOS + Windows |
| Local file access | Full workspace access | Sandboxed by default | User-selected folders |
| Office files (Word/Excel/PPT) | Yes | No | Yes |
| Scheduled automations | Yes | No | No |
| Plugin ecosystem | DSH plugins | No | MCP |

## What You Can Ask PawWork To Do

### Documents and Data

- extract key fields from invoices into a reviewable spreadsheet
- summarize a CSV and write a short report
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

### On a Schedule

Automations run a saved task on a cron schedule — a Monday morning digest of a folder, a nightly export, a recurring check — and leave the results in your workspace.

## How It Works

1. Choose a workspace folder.
2. Describe what you want in everyday language.
3. PawWork works with the files, tools, models, and search it needs.
4. Review the steps, outputs, and files before you use the result.

## Models and Search

PawWork includes a curated set of free models from OpenCode Free, plus built-in web search. You can start without an API key or a paid model subscription. If you prefer your own provider, you can configure one in settings.

The free model list refreshes at runtime from the [models.dev](https://models.dev) catalog and falls back to the packaged list when the catalog is unreachable, so the models shown in the app can change without an update.

## Download

Download the latest macOS and Windows builds from [GitHub Releases](https://github.com/Astro-Han/pawwork/releases/latest).

- **macOS:** download the `.dmg`. Release builds are signed and notarized by Apple.
- **Windows:** download the Windows x64 `.exe`. Windows builds are currently unsigned, so SmartScreen may appear on first launch — choose "More info", then "Run anyway".

PawWork is early and moving fast. Release notes describe what changed in each build.

## What's Inside

PawWork is a DSH runtime, a native desktop shell, and a product layer on top.

- **Runtime** — a pinned set of first-party `@deepseek-ai/dsh-*` packages (sessions, tools, sandbox, compaction, web search, subagents), assembled in a sidecar process rather than shelling out to a `dsh` CLI.
- **Native shell** — [`packages/desktop-electron/src/main`](packages/desktop-electron/src/main): window chrome, application menus, native directory and file pickers, Windows installer hardening, and the auto-updater.
- **Product layer** — [`packages/desktop-electron/resources/dsh`](packages/desktop-electron/resources/dsh): the DSH plugins PawWork owns, including the OpenCode Free model routes, built-in web search, Automations, v1 settings migration, and the desktop host bridge.
- **Skills** — [`skills/`](skills): vendored Office skills for `.docx`, `.xlsx`, `.pptx`, and PDF, executed through a bundled [`uv`](https://github.com/astral-sh/uv) Python toolchain so they work without a system Python.

## Build From Source

Requires Node.js 24 and pnpm 11.

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
pnpm install --frozen-lockfile
pnpm dev:desktop
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification steps, packaging, and the contribution workflow.

## FAQ

**Is PawWork free?**
Yes. PawWork is Apache-2.0 licensed and includes free models and built-in web search. You can start without an API key.

**What is the relationship between PawWork and DeepSeek Harness?**
PawWork uses DSH as its agent runtime. It is an independent open-source product that assembles DSH packages, adds a native desktop shell, and adds its own plugins for free models, web search, Automations, and Office work. It is not affiliated with DeepSeek.

**How is PawWork different from other DSH desktop apps?**
Most are launchers aimed at developers who already use DSH and bring their own API key. PawWork is aimed at non-technical users: free models are included, Office document skills and a Python toolchain are bundled, the shell is native rather than the DSH web UI in a window, and builds are signed for macOS and shipped for Windows.

**Can I use DSH plugins in PawWork?**
Yes. The runtime is real DSH, so community plugins install and run.

**Does PawWork work with local files?**
Yes. PawWork runs as a native desktop app with access to the workspace folder you choose. It reads and writes documents, spreadsheets, PDFs, code projects, and generated output files on your machine.

**What file formats does PawWork handle?**
PDF, Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`), CSV, Markdown, plain text, images, and code files. Office files are read and written locally.

**Can PawWork run tasks on a schedule?**
Yes. Automations run a saved task on a cron schedule and write results into your workspace.

**Can I bring my own model?**
Yes. Free models are the default so the first run needs no setup, but you can configure your own provider in settings.

**What platforms does PawWork support?**
macOS (Apple Silicon and Intel, signed and notarized) and Windows x64.

## Runtime and Acknowledgements

PawWork is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Thanks also to the OpenCode project and community, and to [Astral](https://github.com/astral-sh) for `uv`.

Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[Apache License 2.0](LICENSE)
