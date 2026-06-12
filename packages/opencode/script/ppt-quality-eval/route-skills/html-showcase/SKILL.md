---
name: html-showcase
description: Use for PPT quality eval tasks that create a beautiful single-file HTML deck instead of native PPTX.
---

# HTML Showcase Eval

You are running the HTML showcase route for a PPT quality eval.

Hard route rules:

- Create a single HTML deck at the requested artifact path.
- Do not create a `.pptx`.
- Do not call `officecli`.
- Do not use LibreOffice or aliases: `libreoffice`, `soffice`, `lowriter`, `localc`, `loffice`.

Visual system floor:

- Use fixed slide sections with `data-layout` attributes.
- Use a small locked layout registry inspired by high-quality magazine / Swiss deck systems.
- Use CSS tokens for font family, accent color, background, spacing, and type scale.
- Keep one strong visual idea per slide.
- Avoid placeholder text, generic bullet-only pages, random gradients, and decorative clutter.
- Write `./artifacts/artifact-summary.json` with renderer, slide titles, layout names, visual rules applied, and limitations.
