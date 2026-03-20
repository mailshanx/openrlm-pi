# openrlm-pi

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension for [openrlm](https://github.com/mailshanx/openrlm) — a recursive LLM agent with a persistent IPython REPL.

## What it provides

- **`openrlm` tool**: lets the model delegate complex tasks to an `openrlm` subprocess.
- **`/task` command**: lets the user explicitly delegate a task from the Pi prompt.

## Install

Requires [openrlm](https://github.com/user/openrlm):

```bash
pip install openrlm
# or
uv tool install openrlm
```

Install this package into Pi:

```bash
# From git
pi install git:github.com/user/openrlm-pi

# From local checkout
pi install /path/to/openrlm-pi

# Run directly without installing
pi -e ./extensions
```

## Auth behavior

- Default path: `openrlm` uses your normal provider env vars (for example `OPENROUTER_API_KEY`).
- If Pi is currently using `anthropic` or `openai-codex`, this extension bridges Pi's active access token to `openrlm` for that invocation.
- Pi remains the OAuth authority (login + refresh). The extension only provides a temporary per-run auth file through `OPENRLM_AUTH_FILE`.

Optional binary override:

```bash
export OPENRLM_BIN=/path/to/openrlm
```

## Usage

### Tool call

```json
{
	"task": "Load data.csv, compute summary stats, write report.md",
	"context": false
}
```

### Command

```text
/task Load sales.csv, compute monthly revenue by category, write analysis.md
```

### Parameters

| Parameter | Required | Description                                                |
| --------- | -------- | ---------------------------------------------------------- |
| `task`    | Yes      | Self-contained task description                            |
| `context` | No       | Include current Pi conversation context (default: `false`) |

## How it works

For each invocation, the extension spawns `openrlm --json` and:

1. Optionally writes conversation context to a temporary file and passes `--context`.
2. Optionally creates a temporary auth bridge when Pi is on a supported OAuth provider.
3. Streams activity events back into Pi UI.
4. Returns parsed JSON result output.
5. Cleans up temporary files.

Abort handling: SIGTERM first, then SIGKILL after a 5-second grace period.

## License

MIT
