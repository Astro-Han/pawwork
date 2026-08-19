# PawWork Desktop

PawWork's native Electron shell for DeepSeek DSH.

## Development

From the repo root:

```bash
bun install
bun run --cwd packages/desktop-electron dev
```

This starts the Electron shell and its owned DSH sidecar.

## Build

To build the Electron main process:

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
