# PPT Quality Eval Report

## Scope Note

Native PPTX and HTML showcase are intentionally scored separately. HTML quality can prove layout discipline, but it cannot prove editable PowerPoint fidelity.

## Aggregate

| Route | Passes | Median Score | Median Band |
|---|---:|---:|---|
| officecli | 0/1 | 60 | weak |
| python-pptx | 2/4 | 96 | excellent |
| pptxgenjs | 2/5 | 84 | usable |
| html-showcase | 3/4 | 100 | excellent |

## Native PPTX Verdict

Native verdict should be based on PPTX structure gates: editability, notes, chart/media XML, explicit run font sizes, and bounds checks.

## HTML Showcase Verdict

HTML verdict should be based on locked layouts, CSS tokens, section count, and visual-system discipline. It is not a native PPTX replacement signal.

## Runs

| Task | Route | Round | Result | Score | Band | Seconds | Commands | Failures |
|---|---|---:|---|---:|---|---:|---:|---|
| investor-update | html-showcase | 1 | pass | 100 | excellent | 114 | 2 |  |
| investor-update | officecli | 1 | fail | 60 | weak | 600 | 22 | opencode run exited with 143.; artifact-summary.json is missing.; Native PPTX has no chart XML for a data-backed task. |
| investor-update | pptxgenjs | 1 | fail | 80 | usable | 276 | 24 | Native PPTX has no title-sized text at or above 36pt. |
| investor-update | python-pptx | 1 | fail | 84 | usable | 207 | 5 | Native PPTX has no title-sized text at or above 36pt. |
| report-to-deck | html-showcase | 1 | fail | 84 | usable | 173 | 4 | Missing required text: 8-12 hours |
| report-to-deck | pptxgenjs | 1 | fail | 84 | usable | 199 | 10 | Native PPTX has no media relationship for the image task. |
| report-to-deck | python-pptx | 1 | fail | 60 | weak | 179 | 3 | Missing required text: Field Service AI; Missing required text: 8-12 hours; Native PPTX has no media relationship for the image task. |
| template-following | html-showcase | 1 | pass | 100 | excellent | 120 | 3 |  |
| template-following | pptxgenjs | 1 | pass | 96 | excellent | 447 | 24 |  |
| template-following | python-pptx | 1 | pass | 96 | excellent | 392 | 11 |  |
| investor-update | pptxgenjs | 2 | pass | 100 | excellent | 199 | 11 |  |
| investor-update | python-pptx | 2 | pass | 96 | excellent | 188 | 11 |  |
| report-to-deck | html-showcase | 2 | pass | 100 | excellent | 113 | 0 |  |
| report-to-deck | pptxgenjs | 2 | fail | 84 | usable | 226 | 7 | Native PPTX has no media relationship for the image task. |