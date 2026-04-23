---
name: data-analysis
description: Use when user wants analysis, charts, summaries, or reports from spreadsheets, CSVs, or tabular data
---

# Data Analysis

Analyze structured local data and return conclusions, charts, or updated files.

<GATE>
Do NOT start analyzing until you understand the data and the decision the analysis should support.

When important context is missing, use the `question` tool instead of asking only in plain text. Ask a focused round of questions, typically 2-4, and ask fewer when only one material gap is missing. Ask deeper, non-obvious questions that uncover the user's goal, metrics, constraints, and tradeoffs. Provide your recommended answer as the first option when useful. Use multiple selection when several outputs or dimensions may be needed.

Do not ask obvious questions whose answers are already in the user's message. Stop asking once you can produce a useful first analysis. Ask another focused round only if the user's answer reveals a material gap.

Before asking, use this decision rule:
- **Must ask** when the missing answer changes the metric, time range, grouping, output format, or decision the analysis supports.
- **Use a recommended default and continue** when the missing answer is only a preference, such as chart style, wording length, or whether to include extra detail.
- **Ask one multiple-choice question** when several safe defaults are possible. Put the recommended default first and explain why it is recommended.
</GATE>

## Workflow

1. **Clarify** - Use focused questions to understand what result would be useful before touching any data.
2. **Execute** - Inspect the data, run the analysis, and produce the requested outputs.
3. **Verify** - Check that the findings and deliverables match the user's request.

## Step 1: Clarify

Use the question tool to ask what matters before acting:

- **Data source**: Is it a spreadsheet (xlsx/csv), a database export, or will they describe the data in chat?
- **Output**: Do they want a summary report, a chart or visualization, an updated spreadsheet, or some combination?
- **Business question**: What question should the analysis answer? Confirm key metrics, dimensions, and date ranges when they matter.
- **Decision use**: What will the user do with the answer? This determines how much precision, explanation, and caution the analysis needs.

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
