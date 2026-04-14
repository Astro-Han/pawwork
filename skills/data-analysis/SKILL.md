---
name: data-analysis
description: Analyze spreadsheets and CSVs, create charts, and produce structured reports.
---

# Data Analysis

Use this skill when the user wants analysis, summaries, charts, comparisons, or report-ready tables from local files.

## Scene Detection

- Use for spreadsheets, csv, tsv, charting, KPI summaries, comparisons, and report outputs.
- If the user mainly needs copywriting or a memo, do the analysis here first and hand off final prose tone to `writing-assistant` only if needed.

## AskUserQuestion Flow

Use AskUserQuestion to confirm:

1. Which file or files contain the data?
2. What question should the analysis answer?
3. Do they want a report, a chart image, an updated spreadsheet, or all three?
4. Are there date ranges, dimensions, or metrics that matter most?

If the business question is vague, force clarity before running analysis.

## Workflow

1. Inspect the schema and identify the relevant tables, sheets, and columns.
2. Validate obvious data-quality issues, missing values, malformed dates, duplicate rows, or mixed units.
3. Run the requested aggregation or comparison.
4. Produce the requested outputs, spreadsheet, chart image, report, or a combination.
5. State the main finding first, then supporting detail.

## Tool Rules

- Prefer `officecli` for xlsx reading and writing when formulas or workbook structure matter.
- Use Node.js parsing for csv and tsv plus lightweight table reshaping.
- Use `sharp` only for chart or image output generation.
- Do not require `opencli`. Stay within local files and bundled tools.

## Error Handling and Degradation

- If the data is incomplete, contradictory, or suspicious, call it out explicitly instead of smoothing it over.
- If a chart cannot be produced cleanly, return the analysis table and explain what blocked the chart.
- If the workbook is too complex for safe rewriting, write a separate output file instead of corrupting the original.

## Output Requirements

- State the main finding first.
- Include the exact file path for any generated spreadsheet, image, or report.
- If data quality looks suspicious, call it out explicitly instead of smoothing it over.
