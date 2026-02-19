---
name: arcgeneral
description: Delegate data analysis, multi-step computation, persistent-REPL tasks, and recursive sub-agent workflows to an arcgeneral agent. Use when the task requires running Python code with persistent state across multiple steps, installing packages, analyzing data files, or decomposing complex problems into sub-agent tasks.
---

# arcgeneral

A recursive LLM agent with a persistent IPython REPL. Use the `arcgeneral` tool to delegate tasks that benefit from stateful computation.

## When to use the arcgeneral tool

**Use it for:**
- Data analysis on CSV, JSON, Parquet, or database files (pandas, polars, numpy)
- Multi-step computation where intermediate results must persist (variables, DataFrames, fitted models)
- Statistical analysis, hypothesis testing, regression, clustering
- File format conversions, batch transformations, ETL pipelines
- Plotting and visualization (matplotlib, seaborn, plotly — saves to files)
- Tasks requiring package installation (`uv pip install` inside the REPL)
- Complex problems that benefit from recursive decomposition into sub-agents
- Prototyping algorithms with iterative refinement in a live REPL

**Do NOT use it for:**
- Reading, searching, or editing source code files — use read/grep/edit directly
- Simple shell commands — use bash directly
- Tasks that don't involve computation or persistent state
- Quick one-off calculations you can do inline

## How it works

The agent gets its own IPython REPL where variables, imports, and function definitions persist across tool rounds. It can:
- Install packages with `uv pip install`
- Load and manipulate data across multiple steps without re-reading files
- Spawn recursive sub-agents for parallel subtask decomposition
- Access any files in the current working directory

## Task prompt guidelines

The `task` parameter must be **self-contained**. The agent cannot see your conversation unless you set `context=true`.

Good task prompts:
- "Load sales.csv, compute monthly revenue by product category, identify the top 3 growth categories, and save a summary to analysis.md"
- "Read measurements.json, fit a linear regression of temperature vs. altitude, report R² and coefficients, and plot residuals to residuals.png"

Poor task prompts:
- "Analyze the data" (which data? what analysis? what output?)
- "Continue the analysis" (without context=true, the agent has no history)

## Parameters

- `task` (required): Self-contained task description with file paths and expected output
- `context` (optional, default false): Set to true if the task references prior conversation
- `model` (optional): Override the LLM model (e.g. `anthropic/claude-sonnet-4-5`)
- `functions` (optional): Load additional host functions (e.g. `./contrib` for web search)

## Example

```
arcgeneral tool call:
{
  "task": "Load data/experiment_results.csv. For each treatment group, compute mean, std, and 95% CI of the response variable. Run a one-way ANOVA. Save a box plot to results/treatment_comparison.png and a summary table to results/summary.md.",
  "context": false
}
```
