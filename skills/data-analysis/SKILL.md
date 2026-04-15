---
name: data-analysis
description: Use when user wants analysis, charts, summaries, or reports from spreadsheets, CSVs, or tabular data
---

# Data Analysis

Analyze local data files: xlsx, csv, tsv. Produce summaries, charts, or reports. If user mainly needs prose, do analysis here first, hand off tone to `writing-assistant`.

## Clarify Before Acting

Use `question` if the business question is vague. Skip when the request is already specific.

- Which file(s) contain the data
- What question should the analysis answer
- Desired output: report, chart image, updated spreadsheet, or all three
- Key dimensions, metrics, or date ranges

## Tool Selection

| Task | Tool |
|------|------|
| xlsx with formulas/structure | `officecli` |
| csv/tsv parsing, reshaping | Node.js |
| Chart/image output | `sharp` |

Stay within local files and bundled tools.

## Workflow

1. Inspect schema: tables, sheets, columns
2. Flag data-quality issues (missing values, duplicates, mixed units)
3. Run aggregation or comparison
4. Produce requested outputs
5. State the main finding first, then supporting detail

## Guardrails

- Data incomplete or suspicious → call it out explicitly, don't smooth over
- Chart can't render cleanly → return analysis table, explain what blocked it
- Workbook too complex for safe rewriting → write a separate output file
