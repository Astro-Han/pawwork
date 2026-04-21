# Desktop Icons

`icons/source/icon.svg` is the source artwork for PawWork desktop icons.

Run this from `packages/desktop-electron` to generate the files consumed by electron-builder:

```bash
bun ./scripts/generate-icons.ts prod
```

The script writes generated assets to `resources/icons/`, including `icon.icns`, `icon.ico`, Linux PNGs, Windows tile PNGs, Android launcher PNGs, and iOS AppIcon PNGs. It generates both `.icns` and `.ico` directly from PNG buffers, so the icon pipeline can run on macOS, Windows, or Linux without native icon conversion tools. `resources/icons/` is a build artifact and is ignored by git.

The old `icons/prod`, `icons/dev`, and `icons/beta` directories are also generated-output paths and are ignored. All channels currently use the shared source SVG. If a channel needs distinct artwork later, add a new SVG source and update `getIconSource()` in `scripts/generate-icons.ts`.
