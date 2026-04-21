# PawWork Desktop

Native PawWork desktop app, built with Electron.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop-electron dev
```

This starts the Electron shell and renderer development server.

## Build

To build the Electron main process, preload script, and renderer:

```bash
bun run --cwd packages/desktop-electron build
```

To create a local desktop package:

```bash
bun run --cwd packages/desktop-electron package
```

For platform-specific packages:

```bash
bun run --cwd packages/desktop-electron package:mac
bun run --cwd packages/desktop-electron package:win
bun run --cwd packages/desktop-electron package:linux
```
