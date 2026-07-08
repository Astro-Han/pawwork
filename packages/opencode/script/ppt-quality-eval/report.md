# PPT Quality Eval Report

## Scope Note

Native PPTX and HTML showcase are intentionally scored separately. HTML quality can prove layout discipline, but it cannot prove editable PowerPoint fidelity.

## Aggregate

| Route | Passes | Median Score | Median Band |
|---|---:|---:|---|
| officecli | 1/6 | 84 | usable |
| python-pptx | 2/6 | 84 | usable |
| pptxgenjs | 3/6 | 100 | excellent |
| svg-pptx | 3/6 | 96 | excellent |
| html-showcase | 2/6 | 84 | usable |

## Native PPTX Verdict

Native verdict should be based on PPTX structure gates: editability, notes, chart/media XML, explicit run font sizes, and bounds checks.

## HTML Showcase Verdict

HTML verdict should be based on locked layouts, CSS tokens, section count, and visual-system discipline. It is not a native PPTX replacement signal.

## Runs

| Task | Route | Round | Result | Score | Band | Seconds | Commands | Failures |
|---|---|---:|---|---:|---|---:|---:|---|
| investor-update | html-showcase | 1 | pass | 100 | excellent | 129 | 1 |  |
| investor-update | officecli | 1 | fail | 84 | usable | 276 | 34 | Native PPTX has no chart XML for a data-backed task. |
| investor-update | pptxgenjs | 1 | pass | 100 | excellent | 208 | 18 |  |
| investor-update | python-pptx | 1 | pass | 100 | excellent | 149 | 7 |  |
| investor-update | svg-pptx | 1 | pass | 100 | excellent | 429 | 11 |  |
| report-to-deck | html-showcase | 1 | fail | 84 | usable | 12 | 0 | Target artifact does not exist. |
| report-to-deck | officecli | 1 | fail | 84 | usable | 255 | 28 | Native PPTX has no media relationship for the image task. |
| report-to-deck | pptxgenjs | 1 | fail | 84 | usable | 166 | 22 | Native PPTX has no media relationship for the image task. |
| report-to-deck | python-pptx | 1 | fail | 76 | usable | 137 | 11 | Native PPTX has no media relationship for the image task.; Native PPTX is missing speaker notes on content slides. |
| report-to-deck | svg-pptx | 1 | fail | 84 | usable | 274 | 11 | Native PPTX has no media relationship for the image task. |
| template-following | html-showcase | 1 | fail | 76 | usable | 91 | 7 | HTML showcase route called officecli.; Expected 5 HTML slides, found 0. |
| template-following | officecli | 1 | fail | 0 | failed | 134 | 12 | artifact-summary.json is missing.; Expected 5 slides, found 6.; Missing required text: HelioOps Partner Strategy; Missing required text: Partners Matter; Missing required text: Partner Motion; Missing required text: 90-Day; Missing required text: ServiceTitan; Native PPTX is missing speaker notes on content slides. |
| template-following | pptxgenjs | 1 | pass | 100 | excellent | 335 | 26 |  |
| template-following | python-pptx | 1 | fail | 84 | usable | 296 | 20 | Native PPTX is missing speaker notes on content slides. |
| template-following | svg-pptx | 1 | pass | 96 | excellent | 333 | 18 |  |
| investor-update | html-showcase | 2 | pass | 100 | excellent | 140 | 2 |  |
| investor-update | officecli | 2 | fail | 84 | usable | 199 | 32 | Native PPTX has no chart XML for a data-backed task. |
| investor-update | pptxgenjs | 2 | pass | 100 | excellent | 277 | 16 |  |
| investor-update | python-pptx | 2 | pass | 100 | excellent | 237 | 4 |  |
| investor-update | svg-pptx | 2 | pass | 96 | excellent | 697 | 28 |  |
| report-to-deck | html-showcase | 2 | fail | 84 | usable | 129 | 11 | Missing required text: 8-12 hours |
| report-to-deck | officecli | 2 | fail | 84 | usable | 423 | 32 | Native PPTX has no media relationship for the image task. |
| report-to-deck | pptxgenjs | 2 | fail | 76 | usable | 132 | 7 | Missing required text: 8-12 hours; Native PPTX has no media relationship for the image task. |
| report-to-deck | python-pptx | 2 | fail | 76 | usable | 149 | 9 | Native PPTX has no media relationship for the image task.; Native PPTX is missing speaker notes on content slides. |
| report-to-deck | svg-pptx | 2 | fail | 84 | usable | 760 | 30 | Native PPTX has no media relationship for the image task. |
| template-following | html-showcase | 2 | fail | 76 | usable | 156 | 7 | HTML showcase route called officecli.; Expected 5 HTML slides, found 0. |
| template-following | officecli | 2 | pass | 100 | excellent | 625 | 52 |  |
| template-following | pptxgenjs | 2 | fail | 84 | usable | 335 | 21 | PptxGenJS route called officecli. |
| template-following | python-pptx | 2 | fail | 84 | usable | 584 | 22 | Native PPTX is missing speaker notes on content slides. |
| template-following | svg-pptx | 2 | fail | 72 | usable | 998 | 37 | SVG PPTX route called officecli.; Native PPTX is missing speaker notes on content slides. |