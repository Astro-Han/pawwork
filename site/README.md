# PawWork site

Download landing page for PawWork. Built with [Astro](https://astro.build/) (plain CSS, no UI framework). Deploys as a static site to Cloudflare Pages, independent of the desktop app build.

## Develop

```sh
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # outputs to dist/
pnpm preview  # serve the production build locally
```

## Structure

```text
src/
  pages/index.astro     English page
  pages/zh-CN/          Chinese page
  layouts/Base.astro    <head>, SEO tags, theme script
  styles/global.css     all styling; light/dark via [data-theme]
  i18n.ts               EN/CN copy dictionary
  config.ts             download links and repo URLs
public/
  app-icon.svg          favicon + brand mark
```

## Notes

- **Language**: English is served at `/`; Chinese is served at `/zh-CN/`.
- **Download links**: `config.ts` resolves release downloads from the published R2 manifest and falls back to GitHub Releases.
- **OG image**: `Base.astro` uses the app icon as a placeholder; replace with a dedicated 1200×630 share image.
