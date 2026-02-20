/**
 * arcgeneral Extension for pi
 *
 * Registers:
 * - `arcgeneral` tool: LLM can delegate data analysis, multi-step computation,
 *   and persistent-REPL tasks to an arcgeneral agent process.
 * - `/task` command: user can explicitly delegate a task via the command line.
 *
 * Each invocation spawns a fresh `arcgeneral --json` process with optional
 * conversation context bridged from pi's session history.
 *
 * Prerequisites:
 *   uv tool install arcgeneral          # or pip install arcgeneral
 *   # API key is bridged automatically when Pi uses Anthropic (including OAuth login).
 *   # For OpenRouter: export OPENROUTER_API_KEY=...
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const CONTEXT_MAX_ENTRIES = 200;

// ─── Binary resolution ──────────────────────────────────────────────────

/**
 * Find the arcgeneral binary. Checks (in order):
 * 1. ARCGENERAL_BIN env var (explicit override)
 * 2. uv tool bin directory (~/.local/bin/arcgeneral)
 * 3. PATH via `which`
 */
function resolveArcgeneralBin(): string {
	const envBin = process.env.ARCGENERAL_BIN;
	if (envBin) return envBin;

	// uv tool install puts binaries here
	const uvToolBin = path.join(os.homedir(), ".local", "bin", "arcgeneral");
	if (fs.existsSync(uvToolBin)) return uvToolBin;

	// Fall back to PATH — the spawn will fail with a clear error if not found
	return "arcgeneral";
}

// ─── Context bridging ───────────────────────────────────────────────────

/**
 * Extract user/assistant message pairs from pi's session entries.
 * Drops tool messages, system messages, and other entry types.
 * Returns a JSON-serializable array for arcgeneral's --context flag.
 */
function extractConversationContext(
	ctx: ExtensionContext,
): Array<{ role: "user" | "assistant"; content: string }> {
	const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
	let count = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (count >= CONTEXT_MAX_ENTRIES) break;
		if (entry.type !== "message") continue;

		const msg = (entry as any).message;
		if (!msg) continue;

		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							?.filter((p: any) => p.type === "text")
							.map((p: any) => p.text)
							.join("\n") || "";
			if (text) {
				messages.push({ role: "user", content: text });
				count++;
			}
		} else if (msg.role === "assistant") {
			const text = msg.content
				?.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("\n");
			if (text) {
				messages.push({ role: "assistant", content: text });
				count++;
			}
		}
	}

	return messages;
}

/**
 * Write context messages to a temp file and return the path.
 * Caller is responsible for cleanup.
 */
function writeContextFile(
	messages: Array<{ role: string; content: string }>,
): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-arcgeneral-"));
	const filePath = path.join(tmpDir, "context.json");
	fs.writeFileSync(filePath, JSON.stringify(messages), "utf-8");
	return filePath;
}

/**
 * Write an API key to a file atomically (write tmp + rename).
 * Returns the file path on first call, reuses same path on subsequent calls.
 */
function writeTokenFile(dir: string, token: string): string {
	const filePath = path.join(dir, "token");
	const tmpPath = filePath + ".tmp";
	fs.writeFileSync(tmpPath, token, { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmpPath, filePath);
	return filePath;
}

// ─── Output truncation ──────────────────────────────────────────────────

function truncateOutput(text: string): { text: string; truncated: boolean } {
	const lines = text.split("\n");
	let bytes = 0;
	let lineCount = 0;

	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
		if (bytes + lineBytes > MAX_OUTPUT_BYTES || lineCount >= MAX_OUTPUT_LINES) {
			const kept = lines.slice(0, lineCount).join("\n");
			return {
				text: kept + `\n\n[Truncated: showing ${lineCount} of ${lines.length} lines]`,
				truncated: true,
			};
		}
		bytes += lineBytes;
		lineCount++;
	}

	return { text, truncated: false };
}

// ─── arcgeneral process runner ──────────────────────────────────────────

interface ArcgeneralResult {
	result: string | null;
	error: string | null;
	exitCode: number;
	stderr: string;
}

async function runArcgeneral(opts: {
	task: string;
	context?: boolean;
	contextMessages?: Array<{ role: string; content: string }>;
	model?: string;
	provider?: string;
	functions?: string;
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	apiKey?: string;
	tokenRefresher?: () => Promise<string | undefined>;
}): Promise<ArcgeneralResult> {
	const bin = resolveArcgeneralBin();
	const args: string[] = ["--json"];

	if (opts.model) args.push("--model", opts.model);
	if (opts.provider) args.push("--provider", opts.provider);
	if (opts.functions) args.push("--functions", opts.functions);

	let contextFile: string | null = null;
	if (opts.context && opts.contextMessages && opts.contextMessages.length > 0) {
		contextFile = writeContextFile(opts.contextMessages);
		args.push("--context", contextFile);
	}

	args.push(opts.task);
	let tokenFile: string | null = null;
	let tokenDir: string | null = null;
	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	const envOverrides: Record<string, string> = {};

	if (opts.tokenRefresher) {
		const initialToken = await opts.tokenRefresher();
		if (initialToken) {
			tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-arcgeneral-token-"));
			fs.chmodSync(tokenDir, 0o700);
			tokenFile = writeTokenFile(tokenDir, initialToken);
			// Set both: ARCGENERAL_TOKEN_FILE for live refresh, ANTHROPIC_API_KEY for initial
			envOverrides.ARCGENERAL_TOKEN_FILE = tokenFile;
			envOverrides.ANTHROPIC_API_KEY = initialToken;

			refreshInterval = setInterval(async () => {
				try {
					const newToken = await opts.tokenRefresher!();
					if (newToken && tokenFile) {
						writeTokenFile(path.dirname(tokenFile), newToken);
					}
				} catch { /* refresh failed, subprocess keeps using last good token */ }
			}, 240_000);
		}
	} else if (opts.apiKey) {
		envOverrides.ANTHROPIC_API_KEY = opts.apiKey;
	}

	return new Promise<ArcgeneralResult>((resolve) => {
		const proc = spawn(bin, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...envOverrides },
		});

		let stdout = "";
		let stderr = "";
		let hasExited = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		const cleanup = () => {
			if (refreshInterval) {
				clearInterval(refreshInterval);
				refreshInterval = null;
			}
			if (contextFile) {
				try { fs.unlinkSync(contextFile); } catch { /* ignore */ }
				try { fs.rmdirSync(path.dirname(contextFile)); } catch { /* ignore */ }
			}
			if (tokenFile) {
				try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
				const tmpPath = tokenFile + ".tmp";
				try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
			}
			if (tokenDir) {
				try { fs.rmdirSync(tokenDir); } catch { /* ignore */ }
			}
		};

		proc.on("close", (code) => {
			hasExited = true;
			if (killTimer) clearTimeout(killTimer);
			cleanup();

			// Parse JSON output
			try {
				const parsed = JSON.parse(stdout.trim());
				resolve({
					result: parsed.result ?? null,
					error: parsed.error ?? null,
					exitCode: code ?? 0,
					stderr,
				});
			} catch {
				// JSON parse failed — raw output
				resolve({
					result: stdout.trim() || null,
					error: code !== 0 ? (stderr.trim() || `Process exited with code ${code}`) : null,
					exitCode: code ?? 1,
					stderr,
				});
			}
		});

		proc.on("error", (err) => {
			hasExited = true;
			if (killTimer) clearTimeout(killTimer);
			cleanup();

			if (err.message.includes("ENOENT")) {
				resolve({
					result: null,
					error: `arcgeneral not found. Install with: uv tool install arcgeneral\n(or set ARCGENERAL_BIN to the binary path)`,
					exitCode: 1,
					stderr: err.message,
				});
			} else {
				resolve({
					result: null,
					error: err.message,
					exitCode: 1,
					stderr: err.message,
				});
			}
		});

		// Timeout
		const timeoutMs = (opts.timeout ?? 300) * 1000;
		const timer = setTimeout(() => {
			if (!hasExited) {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!hasExited) {
						try { proc.kill("SIGKILL"); } catch { /* already dead */ }
					}
				}, 5000);
			}
		}, timeoutMs);

		proc.on("close", () => clearTimeout(timer));

		// Abort signal
		if (opts.signal) {
			const killProc = () => {
				if (!hasExited) {
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!hasExited) {
							try { proc.kill("SIGKILL"); } catch { /* already dead */ }
						}
					}, 5000);
				}
			};
			if (opts.signal.aborted) killProc();
			else opts.signal.addEventListener("abort", killProc, { once: true });
		}
	});
}

// ─── Tool schema ────────────────────────────────────────────────────────

const ArcgeneralParams = Type.Object({
	task: Type.String({
		description: "The task to delegate. Must be self-contained — include all necessary context, file paths, and expected output format.",
	}),
	context: Type.Optional(
		Type.Boolean({
			description:
				"If true, include the conversation history from the current session " +
				"so the agent understands what has been discussed. Only use when the " +
				"task references prior conversation. Default: false.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Override the model for this task (e.g. 'anthropic/claude-sonnet-4-5'). " +
				"Defaults to the arcgeneral configured default.",
		}),
	),
	functions: Type.Optional(
		Type.String({
			description:
				"Comma-separated list of host function modules to load " +
				"(e.g. './contrib' for internet search/extract).",
		}),
	),
});

// ─── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const toolDescription = `Delegate a task to an arcgeneral agent — a recursive LLM agent with a persistent IPython REPL.

Use this tool when the task involves:
- Data analysis, computation, or statistical work on files
- Multi-step processing that benefits from persistent variables across steps
- Tasks requiring Python packages (numpy, pandas, matplotlib, etc.)
- Complex file transformations or batch operations
- Problems that benefit from recursive sub-agent decomposition
- Any task where a stateful REPL (variables, imports, computed results persist) is advantageous

Do NOT use this tool for:
- Simple file reads, greps, or edits — use the built-in tools directly
- Tasks that don't need computation or a REPL environment
- Questions you can answer from context without running code

The agent runs in its own IPython environment with access to the working directory. It can install packages, define functions, and persist state across multiple internal tool rounds. It returns a final text result.

The task prompt must be self-contained. The agent cannot see your conversation unless you set context=true.`;

	// ─── LLM config resolution ──────────────────────────────────────
	// Resolve LLM provider and token refresher from Pi's model registry.
	// When Pi is using Anthropic (including OAuth login), bridge the key
	// so arcgeneral uses its native AnthropicClient with stealth mode.
	async function resolveLLMConfig(ctx: ExtensionContext): Promise<{
		provider?: string;
		tokenRefresher?: () => Promise<string | undefined>;
		model?: string;
	}> {
		const model = ctx.model;
		if (!model) return {};
		if (model.provider === "anthropic") {
			return {
				provider: "anthropic",
				tokenRefresher: () => ctx.modelRegistry.getApiKeyForProvider("anthropic"),
				model: model.id,
			};
		}
		// For non-Anthropic providers, arcgeneral uses OpenRouter (its default).
		// The user's OPENROUTER_API_KEY from process.env is inherited automatically.
		return {};
	}

	// ─── Register the arcgeneral tool ────────────────────────────────

	pi.registerTool({
		name: "arcgeneral",
		label: "Arcgeneral",
		description: toolDescription,
		parameters: ArcgeneralParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const contextMessages = params.context
				? extractConversationContext(ctx)
				: undefined;
			const llmConfig = await resolveLLMConfig(ctx);
			const result = await runArcgeneral({
				task: params.task,
				context: params.context,
				contextMessages,
				model: params.model ?? llmConfig.model,
				provider: llmConfig.provider,
				tokenRefresher: llmConfig.tokenRefresher,
				functions: params.functions,
				cwd: ctx.cwd,
				signal,
			});

			if (result.error) {
				return {
					content: [{ type: "text", text: `Error: ${result.error}` }],
					isError: true,
				};
			}

			const output = result.result || "(no output)";
			const { text } = truncateOutput(output);

			return {
				content: [{ type: "text", text }],
			};
		},
	});

	// ─── Register the /task command ─────────────────────────────────
	pi.registerCommand("task", {
		description: "Delegate a task to arcgeneral (persistent IPython REPL agent)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /task <description of the task>", "error");
				return;
			}

			ctx.ui.notify("Delegating to arcgeneral...", "info");

			// Bridge the conversation context and LLM config
			const contextMessages = extractConversationContext(ctx);
			const llmConfig = await resolveLLMConfig(ctx);
			const result = await runArcgeneral({
				task,
				context: true,
				contextMessages,
				provider: llmConfig.provider,
				model: llmConfig.model,
				tokenRefresher: llmConfig.tokenRefresher,
				cwd: ctx.cwd,
			});

			if (result.error) {
				pi.sendMessage({
					customType: "arcgeneral-result",
					content: `arcgeneral error: ${result.error}`,
					display: "block",
				});
			} else {
				const output = result.result || "(no output)";
				const { text } = truncateOutput(output);

				// Inject the result back into the conversation as a steer message
				// so the LLM sees it and can summarize/act on it.
				pi.sendUserMessage(
					`[arcgeneral result for task: "${task}"]\n\n${text}`,
					{ deliverAs: "steer" },
				);
			}
		},
	});
}
