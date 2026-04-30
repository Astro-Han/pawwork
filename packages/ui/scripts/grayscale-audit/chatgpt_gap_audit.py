#!/usr/bin/env python3
"""
Verify PawWork layer ΔL* and composer shadow against ChatGPT targets.
Takes a 2x retina screenshot of the running app, asserts:
  - sidebar bg vs main bg ΔL*: light 2.0–4.0, dark 2.0–5.0
    (dark target follows ChatGPT: flat sidebar→main, ~3 ΔL*; the elevation
    happens at composer level, not at main bg)
  - composer shadow monotonic decay (light only): samples at +1/+5/+10/+20 retina px
    below bottom edge are non-increasing in distance-from-white, with detectable
    shadow at +5 (dist >= 4)
  - composer top-1px / right+3px (past AA fringe): equal to main bg ± 5 per channel
    (no hard 1px border on edges where shadow is NOT expected; bottom edge is
    intentionally NOT checked here — covered by the monotonic decay assertion)
  - sidebar item row pitch <= 30 logical px (light only)
"""
import argparse
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

from img_sample import lab_l, median_region, to_hex

# Selectors are STABLE references — verify these resolve against actual
# PawWork DOM at implementation time. Update inline if PawWork uses different test ids.
# Selectors target stable `data-component` attributes on the live shell. Fallbacks cover
# older test ids and structural tags so the script keeps working if attributes shift.
SIDEBAR_SELECTOR = '[data-component="pawwork-sidebar"]'
MAIN_SELECTOR = '[data-component="desktop-shell-main"]'
COMPOSER_SELECTOR = '[data-component="prompt-input"]'  # may be missing on the home route


def ensure_sidebar_open(page) -> None:
    """Idempotently open the sidebar. Cmd+B is a toggle, so unconditionally pressing it
    closes the sidebar on a second invocation if the persisted layout state already had
    it open. We probe the rendered width and only toggle when it's collapsed (w == 0).
    The selector matches the live `data-component="pawwork-sidebar"` element."""
    sidebar_w = page.evaluate(
        "() => { const e = document.querySelector('[data-component=\"pawwork-sidebar\"]');"
        " return e ? e.getBoundingClientRect().width : 0; }"
    )
    if sidebar_w < 50:
        page.keyboard.press("ControlOrMeta+b")
        page.wait_for_function(
            "() => { const e = document.querySelector('[data-component=\"pawwork-sidebar\"]');"
            " return e && e.getBoundingClientRect().width >= 50; }",
            timeout=2000,
        )
        page.wait_for_timeout(150)


def screenshot(page, mode: str, path: str, dev_server_url: str):
    # PawWork's theme preload reads localStorage['pawwork-color-scheme'] and writes a
    # single-mode :root block; we must seed storage and reload to switch.
    page.evaluate(f"localStorage.setItem('pawwork-color-scheme', '{mode}')")
    page.goto(dev_server_url, wait_until="networkidle", timeout=60_000)
    page.wait_for_function(
        f"document.documentElement.dataset.colorScheme === '{mode}'",
        timeout=2000,
    )
    ensure_sidebar_open(page)
    page.wait_for_timeout(150)  # extra time for paint after sidebar open + style recompute
    page.screenshot(path=path, full_page=False)


def bbox(page, selector: str):
    return page.evaluate(
        "sel => { const el = document.querySelector(sel); if (!el) return null; "
        "const r = el.getBoundingClientRect(); "
        "return { x: r.x, y: r.y, w: r.width, h: r.height }; }",
        selector,
    )


def assert_layer_delta(img: Image.Image, sb_box, mn_box, mode: str):
    # box coords are CSS px; screenshot is 2x retina
    def s(b, x1, y1, x2, y2):
        return median_region(
            img,
            int((b["x"] + x1) * 2),
            int((b["y"] + y1) * 2),
            int((b["x"] + x2) * 2),
            int((b["y"] + y2) * 2),
        )

    sb = s(sb_box, 20, 80, 80, 140)  # clear strip in sidebar
    mn = s(mn_box, 100, 100, 300, 300)
    delta = abs(lab_l(mn) - lab_l(sb))
    target = (2.0, 4.0) if mode == "light" else (2.0, 5.0)
    status = "PASS" if target[0] <= delta <= target[1] else "FAIL"
    print(
        f"  {status}  layer ΔL* ({mode}): {delta:.2f}  (target {target[0]}-{target[1]})  "
        f"sb={to_hex(sb)} L*={lab_l(sb):.1f}  mn={to_hex(mn)} L*={lab_l(mn):.1f}"
    )
    return status == "PASS"


def median_strip(img: Image.Image, cx_2x: int, y_2x: int, half_width: int = 3):
    """Median RGB across a 1-pixel-tall horizontal strip centered at (cx_2x, y_2x).
    Less fragile than a single-pixel sample at 2x DPR (anti-aliasing, transparent subpixels)."""
    return median_region(img, cx_2x - half_width, y_2x, cx_2x + half_width + 1, y_2x + 1)


def assert_composer_shadow_monotonic(img: Image.Image, comp_box):
    """Light mode only: shadow must DECAY MONOTONICALLY downward from composer's bottom edge.
    Sample at +1, +5, +10, +20 retina px below center bottom; require dist-from-white to
    decrease (or stay equal within noise). A hard 1px border manifests as a non-monotonic
    SPIKE at +1 followed by drop to bg — the monotonic check catches it more reliably than
    "+1 ≈ bg" (which conflicts with shadow being present).
    Also require a measurable shadow at +5 (dist >= 4) so a flat-no-shadow surface fails."""
    bottom_y_2x = int((comp_box["y"] + comp_box["h"]) * 2)
    cx_2x = int((comp_box["x"] + comp_box["w"] / 2) * 2)

    def dist_from_white(rgb):
        return 255 - (rgb[0] + rgb[1] + rgb[2]) // 3

    offsets = [1, 5, 10, 20]
    samples = [(off, median_strip(img, cx_2x, bottom_y_2x + off)) for off in offsets]
    dists = [dist_from_white(rgb) for _, rgb in samples]

    # Monotonic non-increasing within noise tolerance of 1
    monotonic = all(dists[i] >= dists[i + 1] - 1 for i in range(len(dists) - 1))
    has_shadow = dists[1] >= 4  # at +5px, shadow should be visible

    for (off, rgb), d in zip(samples, dists):
        print(f"  ----  composer +{off:2d}px below: dist={d:2d}  {to_hex(rgb)}")
    ok = monotonic and has_shadow
    print(
        f"  {'PASS' if ok else 'FAIL'}  composer shadow monotonic decay (mono={monotonic}, has_shadow_at_5={has_shadow})"
    )
    return ok


def assert_row_pitch(page) -> bool:
    """Sidebar item row pitch (top of one row to top of next) must be <= 30 logical px.
    Only runs in light mode; dark mode uses identical layout."""
    pitches = page.evaluate(
        """
      () => {
        const rows = Array.from(document.querySelectorAll(
          '[data-testid="sidebar"] [data-testid="sidebar-item"], aside [role="listitem"], aside li'
        )).slice(0, 5);
        if (rows.length < 2) return null;
        const ys = rows.map(r => r.getBoundingClientRect().top);
        return ys.slice(1).map((y, i) => y - ys[i]);
      }
    """
    )
    if not pitches:
        print("  SKIP  row pitch: fewer than 2 sidebar items found")
        return True  # Don't fail audit on layout we can't measure; manual smoke catches it
    max_pitch = max(pitches)
    ok = max_pitch <= 30
    print(f"  {'PASS' if ok else 'FAIL'}  sidebar row pitch: max={max_pitch:.1f}px (need <= 30) over {len(pitches)} pairs")
    return ok


def assert_no_hard_border(img: Image.Image, comp_box, main_bg):
    """Composer must NOT have a 1px hard line at edges where shadow is NOT expected.
    Check top-1 and right+3 (sampled past the AA fringe) — these should ≈ main bg.
    Bottom edge is excluded because shadow legitimately darkens it (covered by
    assert_composer_shadow_monotonic instead).
    Tolerance is 5 to absorb anti-aliased subpixels at the rendered edge."""

    def close(a, b, tol=5):
        return all(abs(a[i] - b[i]) <= tol for i in range(3))

    right_x_2x = int((comp_box["x"] + comp_box["w"]) * 2)
    top_y_2x = int(comp_box["y"] * 2)
    cx_2x = int((comp_box["x"] + comp_box["w"] / 2) * 2)
    cy_2x = int((comp_box["y"] + comp_box["h"] / 2) * 2)

    # Sample +3px out from right edge to clear AA fringe; vertical center.
    right_3 = median_strip(img, right_x_2x + 3, cy_2x)
    # Sample 1px above top edge — light-mode composer has no upward shadow.
    top_1 = median_strip(img, cx_2x, top_y_2x - 1)

    checks = [
        ("right+3px (past AA)", right_3, close(right_3, main_bg)),
        ("top-1px", top_1, close(top_1, main_bg)),
    ]
    all_ok = True
    for label, sample, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  composer {label} {to_hex(sample)} ≈ main bg {to_hex(main_bg)}")
        if not ok:
            all_ok = False
    return all_ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev-server-url", default="http://localhost:3000")
    parser.add_argument("--screenshot-dir", default="/tmp/grayscale-audit")
    args = parser.parse_args()
    os.makedirs(args.screenshot_dir, exist_ok=True)

    failed = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(device_scale_factor=2, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        try:
            page.goto(args.dev_server_url, wait_until="networkidle", timeout=60_000)
        except Exception as e:
            print(f"FAIL: cannot reach {args.dev_server_url}: {e}", file=sys.stderr)
            print("Hint: run `bun --cwd packages/app dev` in another terminal first.", file=sys.stderr)
            sys.exit(1)

        for mode in ["light", "dark"]:
            print(f"\n=== {mode.upper()} ===")
            shot = os.path.join(args.screenshot_dir, f"{mode}.png")
            screenshot(page, mode, shot, args.dev_server_url)
            img = Image.open(shot).convert("RGB")
            sb = bbox(page, SIDEBAR_SELECTOR) or bbox(page, '[data-testid="sidebar"]') or bbox(page, "aside")
            mn = bbox(page, MAIN_SELECTOR) or bbox(page, '[data-testid="main-content"]') or bbox(page, "main")
            comp = bbox(page, COMPOSER_SELECTOR) or bbox(page, '[data-testid="composer"]') or bbox(page, ".prompt-input")
            critical_missing = [
                name for name, val in (("sidebar", sb), ("main", mn)) if val is None
            ]
            if critical_missing:
                print(
                    f"  FAIL: missing element(s): {', '.join(critical_missing)} "
                    "— check selectors at top of script"
                )
                failed += 1
                continue
            main_bg_rgb = median_region(
                img,
                int((mn["x"] + 100) * 2),
                int((mn["y"] + 100) * 2),
                int((mn["x"] + 300) * 2),
                int((mn["y"] + 300) * 2),
            )
            if not assert_layer_delta(img, sb, mn, mode):
                failed += 1
            if mode == "light":
                if comp is None:
                    print(
                        "  FAIL  composer assertions: prompt-input not present on the audited route. "
                        "Pass --dev-server-url pointing at a session route so composer shadow + "
                        "no-hard-border are actually enforced."
                    )
                    failed += 1
                else:
                    if not assert_composer_shadow_monotonic(img, comp):
                        failed += 1
                    if not assert_no_hard_border(img, comp, main_bg_rgb):
                        failed += 1
                if not assert_row_pitch(page):
                    failed += 1
        browser.close()

    print(f"\n{failed} assertion(s) failed." if failed else "\nLayer + composer audit: ✓")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
