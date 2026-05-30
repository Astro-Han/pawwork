# PawWork site

Download landing page for PawWork. Built with [Astro](https://astro.build/) (plain CSS, no UI framework). Deploys as a static site to Cloudflare Pages, independent of the desktop app build.

## Develop

```sh
bun install
bun run dev      # http://localhost:4321
bun run build    # outputs to dist/
bun run preview  # serve the production build locally
```

## Structure

```text
src/
  pages/index.astro     page markup; English first paint + client-side CN/EN switch
  layouts/Base.astro    <head>, SEO tags, anti-flash theme script
  styles/global.css     all styling; light/dark via [data-theme], CN/EN via [data-lang]
  i18n.ts               EN/CN copy dictionary (single source of truth)
  config.ts             download links and repo URLs
public/
  app-icon.svg          favicon + brand mark
```

## Notes

- **Language**: first paint renders English for basic SEO; the client switches to Chinese based on browser language or the EN/中 toggle. Choice persists in `localStorage`. Per-language routes for SEO are deferred.
- **Download links**: `config.ts` currently points every button at the GitHub Releases page. Swap in China-hosted direct links (R2 / COS) once the updater fallback (issue #219) lands.
- **OG image**: `Base.astro` uses the app icon as a placeholder; replace with a dedicated 1200×630 share image.
