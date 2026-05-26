# App E2E guidance

Keep this file short. Put broad product, UI, and verification policy in the root `AGENTS.md`; keep only `packages/app/e2e`-specific test rules here.

## Commands

- All E2E tests: `bun test:e2e`
- Specific file: `bun test:e2e -- app/home.spec.ts`
- Test title filter: `bun test:e2e -- -g "home renders and shows core entrypoints"`
- Full local server setup: `bun test:e2e:local`
- Interactive debugging/report: `bun test:e2e:ui` / `bun test:e2e:report`

## Imports and fixtures

- Always import `test` and `expect` from `../fixtures`, not `@playwright/test`.
- Prefer the `project` fixture for golden-path user flows and LLM mocking: call `project.open()` before using `project.sdk`, `project.prompt(...)`, `project.gotoSession(...)`, or resource tracking helpers.
- Use `withSession(...)` for lightweight shared-directory session setup.
- Track resources created outside fixture setup with `project.trackSession(...)` and `project.trackDirectory(...)`; avoid direct cleanup through `sdk.session.delete(...)`.

## User-path testing

- Test visible behavior through the UI first. Click, type, and assert the route or visible result a user would see.
- Prefer existing helpers from `actions.ts`, `selectors.ts`, and `utils.ts` when they make intent clearer or already include the required wait.
- Use direct locators for simple interactions; do not wrap trivial one-off actions in new helpers.
- Keep each spec focused on one user-facing behavior.

## Selectors and routing

- Prefer semantic roles, accessible names, `data-component`, and `data-action` selectors.
- Do not target CSS class names or unstable DOM structure.
- Use `modKey` from `utils.ts` for cross-platform keyboard shortcuts.
- When validating routing, use shared URL helpers. Workspace slugs can canonicalize differently on Windows, so assert canonical or resolved slugs.

## Waiting and flakes

- Never use `page.waitForTimeout(...)` to make a test pass.
- Wait for observable state with locator assertions, `expect.poll(...)`, or existing helpers.
- Prefer semantic app state over transient DOM visibility when focus, active selection, routing, async retries, or keyboard ownership matter.
- Do not treat an element being visible as proof that the app will route the next action to it.
- When fixing a flake, validate with `--repeat-each` and multiple workers when practical.

## Terminal tests

- Type through the browser. Do not write to the PTY through the SDK.
- Use `waitTerminalReady(...)`, `runTerminal(...)`, and `waitTerminalFocusIdle(...)` from `actions.ts` for terminal readiness, output, and focus handoff.
- These helpers use the fixture-enabled test-only terminal driver; avoid custom DOM readiness checks for terminal mount or prompt state.

## Test-only hooks

- If required state is not observable from the UI, add a minimal test-only driver or probe instead of sleeps or fragile DOM checks.
- Follow the style of `packages/app/src/testing/terminal.ts`.
- Test-only hooks must be inert unless explicitly enabled; do not add normal-runtime listeners, reactive subscriptions, or per-update allocations for E2E ceremony.
- For mocked routes or APIs, expose explicit mock state and wait on it before asserting post-action UI.
