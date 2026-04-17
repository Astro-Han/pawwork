# PawWork

**Process documents, analyze data, draft content. No API key, no command line, no setup.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-black.svg)](https://github.com/Astro-Han/pawwork/releases/latest)

[中文说明](README_CN.md)

---

PawWork is a desktop app for knowledge workers who want AI to handle real tasks, not just chat. Download the app, open it, and start working with your files.

<!-- TODO: add screenshot here -->

## What You Can Do

- **Office documents** — create and edit Word (.docx), Excel (.xlsx), PowerPoint (.pptx) without installing Office
- **Data analysis** — drop a spreadsheet or CSV, get summaries, charts, and reports
- **Writing help** — draft emails, reports, plans, and announcements from rough notes
- **PDF processing** — merge, split, extract, and convert PDF files

All tools are built in. Nothing to install, no terminal, no package managers.

## Download

macOS (Apple Silicon): **[Download .dmg](https://github.com/Astro-Han/pawwork/releases/latest)**

### macOS first launch

PawWork is not yet signed with Apple Developer ID. On first launch:
Right-click the app > Open > confirm "Open" in the dialog.

## Who This Is For

PawWork is built for people who work with documents, spreadsheets, and writing every day but don't want to learn programming or manage API keys. If you've tried ChatGPT or Claude but wished it could just work with your files directly on your computer, this is for you.

## Build from Source

Requires [Bun](https://bun.sh) v1.2+.

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
cd packages/desktop-electron && bun run dev
```

## Credits

PawWork is a fork of [OpenCode](https://github.com/anomalyco/opencode), with modifications.

## License

[Apache License 2.0](LICENSE)
