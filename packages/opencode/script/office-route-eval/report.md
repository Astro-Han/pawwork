# Office Route Eval Report

## Verdict

Do not open a formal OfficeCLI replacement PR yet. Python route beats OfficeCLI on xlsx and ties docx, but pptx still fails 0/3 on explicit font-size XML.

Next smallest boundary: keep this eval harness as the baseline, then harden only the Python pptx skill/template so generated decks set run-level font sizes and pass the existing pptx judge in at least 2/3 rounds.

## Aggregate

| Task | Route | Passes | Median Seconds | Median Commands |
|---|---:|---:|---:|---:|
| xlsx-dashboard | officecli | 0/3 | 265 | 33 |
| xlsx-dashboard | python | 3/3 | 72 | 3 |
| docx-board-memo | officecli | 3/3 | 123 | 22 |
| docx-board-memo | python | 3/3 | 84 | 5 |
| pptx-pitch-deck | officecli | 0/3 | 296 | 29 |
| pptx-pitch-deck | python | 0/3 | 94 | 4 |

## Runs

| Task | Route | Round | Result | Score | Seconds | Commands | Failures |
|---|---:|---:|---|---:|---:|---:|---|
| docx-board-memo | officecli | 1 | pass | 100 | 123 | 22 |  |
| docx-board-memo | python | 1 | pass | 100 | 84 | 6 |  |
| pptx-pitch-deck | officecli | 1 | fail | 82 | 387 | 40 | Target artifact does not exist at required path; found at ./orion-assist-pitch.pptx. |
| pptx-pitch-deck | python | 1 | fail | 82 | 94 | 4 | PPTX has no explicit run font sizes. |
| xlsx-dashboard | officecli | 1 | fail | 64 | 265 | 33 | XLSX has no chart XML.; XLSX has fewer than three formulas. |
| xlsx-dashboard | python | 1 | pass | 100 | 72 | 3 |  |
| docx-board-memo | officecli | 2 | pass | 100 | 134 | 16 |  |
| docx-board-memo | python | 2 | pass | 100 | 61 | 3 |  |
| pptx-pitch-deck | officecli | 2 | fail | 64 | 296 | 29 | PPTX has no chart XML.; PPTX has no explicit run font sizes. |
| pptx-pitch-deck | python | 2 | fail | 82 | 76 | 4 | PPTX has no explicit run font sizes. |
| xlsx-dashboard | officecli | 2 | fail | 46 | 117 | 23 | XLSX has no chart XML.; XLSX has fewer than three formulas.; XLSX contains formula error token #REF!. |
| xlsx-dashboard | python | 2 | pass | 100 | 111 | 4 |  |
| docx-board-memo | officecli | 3 | pass | 100 | 113 | 52 |  |
| docx-board-memo | python | 3 | pass | 100 | 90 | 5 |  |
| pptx-pitch-deck | officecli | 3 | fail | 64 | 129 | 18 | PPTX has no chart XML.; PPTX has no explicit run font sizes. |
| pptx-pitch-deck | python | 3 | fail | 82 | 114 | 6 | PPTX has no explicit run font sizes. |
| xlsx-dashboard | officecli | 3 | fail | 82 | 448 | 37 | OfficeCLI route appears to create the final artifact through Python Office libraries. |
| xlsx-dashboard | python | 3 | pass | 100 | 66 | 3 |  |

Replacement PR bar: Python route must pass all three task families in at least two of three rounds with zero route-policy failures.