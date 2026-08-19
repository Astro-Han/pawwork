# Desktop Icons

`icons/source/icon.png` is the source artwork for PawWork desktop icons. Keep it square, at least 1024px, and transparent outside the icon silhouette. The detailed mascot artwork is raster-native; wrapping it in SVG or auto-tracing it would not make it a maintainable vector source.

Run this from `packages/desktop-electron` to generate the files consumed by electron-builder:

```bash
pnpm exec tsx ./scripts/generate-icons.ts prod
```

The script writes the macOS and Windows assets consumed by electron-builder to `resources/icons/`, including `icon.icns`, `icon.ico`, shared PNGs, and Windows tile PNGs. It generates both `.icns` and `.ico` directly from PNG buffers, so the icon pipeline does not depend on native icon conversion tools. `resources/icons/` is a build artifact and is ignored by git.

The old `icons/prod`, `icons/dev`, and `icons/beta` directories are also generated-output paths and are ignored. All channels currently use the shared source PNG. If a channel needs distinct artwork later, add a new source asset and update `getIconSource()` in `scripts/generate-icons.ts`.
