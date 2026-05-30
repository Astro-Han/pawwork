import { defineConfig } from "astro/config";

// Landing page; deploys as a static site to Cloudflare Pages, decoupled from the
// desktop app build. `site` provides the absolute origin for canonical / og:url;
// the production domain may change once registration is sorted out.
export default defineConfig({
  site: "https://pawwork.ai",
});
