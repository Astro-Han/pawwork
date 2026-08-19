# PawWork Desktop

PawWork's native Electron shell for DeepSeek DSH.

## Development

From the repo root:

```bash
pnpm install
pnpm --filter @pawwork/desktop dev
```

This starts the Electron shell and its owned DSH sidecar.

## Build

To build the Electron main process:

```bash
pnpm --filter @pawwork/desktop build
```

To create a local desktop package:

```bash
pnpm --filter @pawwork/desktop package
```

For platform-specific packages:

```bash
pnpm --filter @pawwork/desktop package:mac
pnpm --filter @pawwork/desktop package:win
```
