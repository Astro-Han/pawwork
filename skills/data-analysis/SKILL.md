---
name: data-analysis
description: Use when user wants analysis, charts, summaries, or reports from spreadsheets, CSVs, or tabular data
---

# Data Analysis

Analyze structured local data and return conclusions, charts, or updated files.

<GATE>
Do NOT start analyzing until you understand the data and the question. Ask clarifying questions first, then act.
</GATE>

## Workflow

1. **Clarify** - Ask the user what they need before touching any data.
2. **Execute** - Inspect the data, run the analysis, and produce the requested outputs.
3. **Verify** - Check that the findings and deliverables match the user's request.

## Step 1: Clarify

Ask the user the following before acting:

- **Data source** — Is it a spreadsheet (xlsx/csv), a database export, or will they describe the data in chat?
- **Output** — Do they want a summary report, a chart or visualization, an updated spreadsheet, or some combination?
- **Business question** — What question should the analysis answer? Confirm key metrics, dimensions, and date ranges when they matter.

## Step 2: Execute

| Task | Tool |
| --- | --- |
| xlsx with formulas or workbook structure | `officecli` |
| csv or tsv parsing, reshaping, aggregation | Node.js |
| Chart or image output | `sharp` |

Execution rules:
- Inspect sheets, tables, columns, and units before calculating anything.
- Flag data-quality problems, such as missing values, duplicates, mixed units, or suspicious totals.
- Keep analysis steps traceable so the result can be checked.
- If workbook rewriting is risky, write a separate output file instead of overwriting the source.

## Step 3: Verify

Before reporting back:
- Recheck the main finding against the underlying data.
- Confirm each requested output was produced.
- Call out any data-quality issue that changes confidence in the answer.
- State the main finding first, then supporting detail.

## Language

Reply in the user's locale (shown in system environment as "User locale").
If no locale is shown, match the language used in the user's request.
