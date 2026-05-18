import { DiffLineAnnotation, FileContents, FileDiffOptions, type SelectedLineRange } from "@pierre/diffs"
import { ComponentProps } from "solid-js"
import { lineCommentStyles } from "../components/line-comment-styles"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diff],
[data-file] {
  /* pierre renders diffs through codeToHtml with the PawWorkDiff theme (see */
  /* context/marked.tsx), so the inline <pre> background is var(--bg-base). */
  /* pierre's own color-mix formulas derive context/separator off that base. */
  /* We point add/del at the PawWork semantic alpha tokens, which carry their */
  /* own light/dark values (see packages/ui/src/styles/theme.css and */
  /* themes/pawwork.json), so no :host([data-color-scheme='dark']) branch is */
  /* needed for the row tints. Issue #705. */
  --diffs-bg-addition-override: var(--diff-add);
  --diffs-bg-addition-number-override: var(--diff-add);
  --diffs-bg-deletion-override: var(--diff-del);
  --diffs-bg-deletion-number-override: var(--diff-del);

  /* Buffer, context rows, and hunk separators ("N unmodified lines") stay flat */
  /* over --bg-base. The chevron expand button shares --diffs-bg-separator */
  /* (pierre dist/style.js L672), so transparent here also kills the gray */
  /* raised-block look. */
  --diffs-bg-buffer-override: transparent;
  --diffs-bg-context-override: transparent;
  --diffs-bg-separator-override: transparent;

  --diffs-selection-base: var(--warning-bg);
  --diffs-selection-border: var(--warning);
  --diffs-selection-number-fg: #1c1917;
  /* Use explicit alpha instead of color-mix(..., transparent) to avoid Safari's non-premultiplied interpolation bugs. */
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--warning-bg) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--warning-bg) r g b / 0.85)
  );
  --diffs-bg-selection-text: rgb(from var(--warning-bg) r g b / 0.2);
}

:host([data-color-scheme='dark']) [data-diff],
:host([data-color-scheme='dark']) [data-file] {
  --diffs-selection-number-fg: #fdfbfb;
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--solaris-dark-6) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--solaris-dark-6) r g b / 0.85)
  );
}

[data-diff] ::selection,
[data-file] ::selection {
  background-color: var(--diffs-bg-selection-text);
}

::highlight(opencode-find) {
  background-color: rgb(from var(--warning-bg) r g b / 0.35);
}

::highlight(opencode-find-current) {
  background-color: rgb(from var(--warning-bg) r g b / 0.55);
}

[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-file] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-diff] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-column-number][data-line-type='context'][data-selected-line],
[data-diff] [data-column-number][data-line-type='context-expanded'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-addition'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-deletion'][data-selected-line] {
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
[data-diff] [data-line][data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 0.07),
    rgb(from var(--diffs-deletion-base) r g b / 0.1)
  );
}

[data-diff-header],
[data-diff],
[data-file] {
  [data-separator] {
    height: 24px;
  }
  [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
    overflow-y: clip !important;
  }
}

${lineCommentStyles}

`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: "PawWorkDiff",
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    /* "classic" renders +/− char markers (matches DESIGN.md L482 marker column intent). */
    /* "bars" would draw a 4px solid side stripe per row, which collides with the */
    /* side-stripe ban in our design principles. Issue #705. */
    diffIndicators: "classic",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-caption)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
  /* pierre's default --diffs-gap-style ("2px solid var(--diffs-bg)") paints a visible */
  /* seam between the number column and the code column. Keep the 2px width for spacing */
  /* but make the color transparent so the row's --diffs-line-bg (which already matches */
  /* --diffs-bg-addition / --diffs-bg-deletion) shows through. Issue #705. */
  "--diffs-gap-style": "2px solid transparent",
}
