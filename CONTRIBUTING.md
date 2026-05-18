# Contributing to PawWork

Thanks for contributing to PawWork.

PawWork is a desktop AI workstation for non-technical knowledge workers. When making changes, optimize for clarity, reversibility, and out-of-the-box usability.

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
- For visible UI changes, manually check the desktop app and include screenshots or a short recording in the pull request.

## Development Setup

PawWork uses Bun and requires Node 24 in CI.

```bash
bun install --frozen-lockfile
```

For local development:

```bash
bun run dev:desktop
```

## Branches and Commits

- Open pull requests against `dev`
- Use small, reversible commits
- Use Conventional Commits in English, such as `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`

## Verification

Run the checks relevant to your change before opening a pull request:

```bash
bun turbo typecheck
bun turbo test:ci
```

If your change affects the desktop app or UI, also do a quick manual check in the app and include screenshots or a short recording in the pull request.

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
