# Contributing to PawWork

Thanks for contributing to PawWork.

PawWork packages a DeepSeek Harness agent runtime into a desktop product for non-technical knowledge workers. That framing decides most trade-offs: when making changes, optimize for clarity, reversibility, and whether someone who has never opened a terminal can still succeed on first run.

## Before You Start

- Read [README.md](README.md) for local setup.
- Check existing issues and pull requests before starting work.
- Read recent pull requests to understand current conventions and priorities.

## What We Welcome

- Bug fixes
- Small UX improvements
- Documentation improvements
- New ideas that fit the product direction

Please open an issue first for larger feature proposals or changes that affect product scope.

## Ground Rules

- Keep changes focused. Do not bundle unrelated work.
- Prefer the smallest change that solves the problem well.
- Preserve the product's bilingual direction.
- Optimize for non-technical users, not developer convenience alone.
- Do not rewrite broad areas of the fork without prior discussion.

## Agent Quickstart

AI coding agents should use the same public contribution contract as human contributors.

- Use GitHub issues, pull requests, and CI as the public sources of truth for scope, review state, and merge readiness.
- Do not rely on private local notes, local coordination boards, or personal agent rules to build, test, review, or merge a contribution.
- Start from the smallest issue or task boundary that can be reviewed independently.
- Before changing code, identify the affected product layer and the smallest relevant verification path.
- For visible UI changes, follow the verification and reporting steps in the [Verification](#verification) section.

## Repository Layout

PawWork is a DSH runtime, a native desktop shell, and a product layer on top. Knowing which layer you are in usually tells you which verification path applies.

| Path | What lives there |
|---|---|
| `packages/desktop-electron/src/main` | The Electron main process: window chrome, menus, native pickers, updater, DSH sidecar lifecycle |
| `packages/desktop-electron/resources/dsh` | DSH plugins PawWork owns: OpenCode Free model routes, web search, Automations, v1 migration, desktop host bridge |
| `skills/` | Vendored Office skills (`.docx`, `.xlsx`, `.pptx`, PDF), run through a bundled `uv` Python toolchain |
| `site/` | The pawwork.ai marketing site (Astro). Copy for both languages lives in `site/src/i18n.ts` |

The agent runtime itself comes from pinned `@deepseek-ai/dsh-*` packages and is not vendored here.

## Development Setup

PawWork uses pnpm and requires Node 24 in CI.

```bash
pnpm install --frozen-lockfile
```

For local development:

```bash
pnpm dev:desktop
```

Use pnpm only. Installing with `bun` rewrites the pnpm dependency tree through `node_modules/.bun` and silently breaks the workspace.

To build a local package for one platform:

```bash
pnpm --filter @pawwork/desktop package:mac
pnpm --filter @pawwork/desktop package:win
```

Full cross-platform packaging and signing are CI's job. Build locally only when a problem can be reproduced or verified in a packaged app.

## Branches and Commits

- Open pull requests against `main`
- Use small, reversible commits
- Use Conventional Commits in English, such as `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

## Verification

Run the checks relevant to your change before opening a pull request:

```bash
pnpm typecheck
pnpm lint
pnpm --filter @pawwork/desktop test
```

`pnpm --filter @pawwork/desktop test` runs both the Vitest suite and the Node test files under `resources/dsh`, so changes to the product-layer plugins are covered by the same command.

If your change affects the desktop app or UI, also do a quick manual check in the running app and include screenshots or a short recording in the pull request. Do not update a snapshot only to make a test pass — confirm the new rendering is correct first.

## Pull Requests

- Explain what changed and why
- Link the related issue when there is one
- Keep the pull request small enough to review comfortably
- Include verification steps
- Include screenshots for visible UI changes

## Reporting Bugs and Requesting Features

- Use the bug report form for broken behavior
- Use the feature request form for new capabilities or workflow improvements
- You may write in English or Chinese

## Questions

If you are unsure whether something fits the roadmap, open an issue before investing in implementation.
