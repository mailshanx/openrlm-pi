# arcgeneral-pi

[Pi](https://github.com/mariozechner/pi-coding-agent) extension and skill for [arcgeneral](https://github.com/user/arcgeneral) — a recursive LLM agent with persistent IPython REPL.

## What it does

**`arcgeneral` tool** — the LLM can autonomously delegate tasks to an arcgeneral agent when they involve data analysis, multi-step computation, or anything that benefits from a stateful Python REPL. The agent runs in its own IPython environment, persists variables across steps, can install packages, and supports recursive sub-agent decomposition.

**`/task` command** — you can explicitly delegate a task from the command line. Conversation context from the current pi session is bridged automatically.

**`arcgeneral` skill** — teaches the LLM when to prefer the `arcgeneral` tool over built-in tools (data analysis, persistent state, package installation, recursive decomposition).

## Install

Requires [arcgeneral](https://github.com/user/arcgeneral) on the system:

```bash
pip install arcgeneral
# or
uv tool install arcgeneral
```

Then install this package into pi:

```bash
# From git
pi install git:github.com/user/arcgeneral-pi

# From a local checkout
pi install /path/to/arcgeneral-pi

# Try without installing
pi -e ./extensions/arcgeneral.ts
```

## Configuration

Set an API key for the LLM provider arcgeneral will use:

```bash
export OPENROUTER_API_KEY=...   # default provider
# or provider-specific:
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

Optionally override the binary location:

```bash
export ARCGENERAL_BIN=/path/to/arcgeneral
```

## Usage

### Autonomous (LLM decides)

The LLM will use the `arcgeneral` tool when it determines a task benefits from a persistent REPL. The skill provides guidance on when this is appropriate.

### Explicit (user delegates)

```
/task Load sales.csv, compute monthly revenue by product category, and save a summary to analysis.md
```

### From LLM tool call

```json
{
  "task": "Load data.csv, fit a linear regression of price vs. volume, report R² and coefficients, plot residuals to residuals.png",
  "context": false
}
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `task` | Yes | Self-contained task description with file paths and expected output |
| `context` | No | Include conversation history from the current pi session (default: false) |
| `model` | No | Override the LLM model (e.g. `anthropic/claude-sonnet-4-5`) |
| `functions` | No | Comma-separated host function modules to load (e.g. `./contrib`) |

## How it works

Each invocation spawns a fresh `arcgeneral --json` process. The extension:

1. Optionally extracts user/assistant messages from pi's session history
2. Writes them to a temp file and passes via `--context`
3. Spawns `arcgeneral --json "<task>"` as a subprocess
4. Parses the `{"result", "error"}` JSON output
5. Returns the result to pi (tool) or injects it as a steer message (`/task`)

Abort signals propagate: SIGTERM with 5s grace period, then SIGKILL.

## License

MIT
