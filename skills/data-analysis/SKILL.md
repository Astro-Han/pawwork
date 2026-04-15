---
name: data-analysis
description: Use when user wants analysis, charts, summaries, or reports from spreadsheets, CSVs, or tabular data
---

# Data Analysis

Analyze structured local data and return conclusions, charts, or updated files.

<GATE>
ALWAYS use the `question` tool to clarify before acting.
Do NOT proceed with assumptions. Do NOT skip this step.
</GATE>

## Workflow

1. **Clarify** - Use the `question` tool and ask the predefined questions in one call.
2. **Execute** - Inspect the data, run the analysis, and produce the requested outputs.
3. **Verify** - Check that the findings and deliverables match the user's request.

## Step 1: Clarify

Always ask these questions before acting:

```json
{
  "questions": [
    {
      "question": "What kind of data source are you working with?",
      "header": "Data source",
      "options": [
        { "label": "Spreadsheet (xlsx/csv)", "description": "The data is in a spreadsheet or flat file" },
        { "label": "Database export", "description": "The data came from a database export or report dump" },
        { "label": "I'll describe the data", "description": "I will explain the schema or sample rows in chat" }
      ]
    },
    {
      "question": "What outputs do you want me to produce?",
      "header": "Output",
      "multiple": true,
      "options": [
        { "label": "Summary report", "description": "Write up the main findings and supporting metrics" },
        { "label": "Chart/visualization", "description": "Create a chart or visual output" },
        { "label": "Updated spreadsheet", "description": "Return a modified workbook or data file" }
      ]
    }
  ]
}
```

Also confirm the business question, key metrics, dimensions, and date range when they matter to the analysis.

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
