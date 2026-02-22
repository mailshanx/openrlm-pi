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
function extractConversationContext(ctx: ExtensionContext): Array<{ role: "user" | "assistant"; content: string }> {
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
function writeContextFile(messages: Array<{ role: string; content: string }>): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-arcgeneral-"));
	const filePath = path.join(tmpDir, "context.json");
	fs.writeFileSync(filePath, JSON.stringify(messages), "utf-8");
	return filePath;
}

// ─── Auth file management ─────────────────────────────────────────────────

const ARCGENERAL_AUTH_DIR = path.join(os.homedir(), ".arcgeneral");
const ARCGENERAL_AUTH_FILE = path.join(ARCGENERAL_AUTH_DIR, "auth.json");

/**
 * Write a provider's API key to ~/.arcgeneral/auth.json atomically.
 * Merges with existing entries so other providers are preserved.
 */
function writeAuthFile(provider: string, token: string): void {
	// Ensure directory exists
	if (!fs.existsSync(ARCGENERAL_AUTH_DIR)) {
		fs.mkdirSync(ARCGENERAL_AUTH_DIR, { recursive: true, mode: 0o700 });
	}

	// Read existing entries
	let data: Record<string, string> = {};
	try {
		data = JSON.parse(fs.readFileSync(ARCGENERAL_AUTH_FILE, "utf-8"));
	} catch {
		/* file missing or invalid — start fresh */
	}

	data[provider] = token;

	// Atomic write: tmp + rename
	const tmpPath = ARCGENERAL_AUTH_FILE + ".tmp";
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmpPath, ARCGENERAL_AUTH_FILE);
}

/**
 * Remove a provider's entry from ~/.arcgeneral/auth.json.
 * Called on cleanup so stale tokens don't persist.
 */
function removeAuthEntry(provider: string): void {
	try {
		const data = JSON.parse(fs.readFileSync(ARCGENERAL_AUTH_FILE, "utf-8"));
		delete data[provider];
		if (Object.keys(data).length === 0) {
			try {
				fs.unlinkSync(ARCGENERAL_AUTH_FILE);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(ARCGENERAL_AUTH_FILE + ".tmp");
			} catch {
				/* ignore */
			}
		} else {
			const tmpPath = ARCGENERAL_AUTH_FILE + ".tmp";
			fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
			fs.renameSync(tmpPath, ARCGENERAL_AUTH_FILE);
		}
	} catch {
		/* ignore — file missing or invalid */
	}
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

interface AgentNode {
	parentId: string;
	depth: number;
	status: "idle" | "running" | "done";
	round: number;
	maxRounds: number;
}

class AgentTree {
	private agents = new Map<string, AgentNode>();
	private lastActiveId = "main";

	handleEvent(event: { type: string; [key: string]: unknown }): void {
		const id = event.agent_id as string;
		switch (event.type) {
			case "AgentCreated":
				this.agents.set(id, {
					parentId: event.parent_id as string,
					depth: event.depth as number,
					status: "idle",
					round: 0,
					maxRounds: 0,
				});
				break;
			case "TaskStarted": {
				const node = this.agents.get(id);
				if (node) node.status = "running";
				break;
			}
			case "RoundStart": {
				if (!this.agents.has(id)) {
					this.agents.set(id, { parentId: "", depth: 0, status: "running", round: 0, maxRounds: 0 });
				}
				const node = this.agents.get(id)!;
				node.round = (event.round_num as number) + 1;
				node.maxRounds = event.max_rounds as number;
				node.status = "running";
				this.lastActiveId = id;
				break;
			}
			case "TaskCompleted": {
				const node = this.agents.get(id);
				if (node) node.status = "done";
				break;
			}
		}
	}

	hasSubAgents(): boolean {
		return this.agents.size > 1;
	}

	renderStatus(): string {
		const active = this.agents.get(this.lastActiveId);
		if (!active) return "arcgeneral: starting...";
		const total = this.agents.size;
		return total <= 1
			? `arcgeneral: round ${active.round}/${active.maxRounds}`
			: `arcgeneral: ${total} agents, round ${active.round}/${active.maxRounds}`;
	}

	renderTree(): string[] {
		const children = new Map<string, string[]>();
		let rootId: string | undefined;
		for (const [id, node] of this.agents) {
			if (node.parentId === "") {
				rootId = id;
			} else {
				const siblings = children.get(node.parentId);
				if (siblings) siblings.push(id);
				else children.set(node.parentId, [id]);
			}
		}
		if (!rootId) return [];

		const lines: string[] = [];

		const formatStatus = (node: AgentNode): string => {
			switch (node.status) {
				case "running":
					return `round ${node.round}/${node.maxRounds}`;
				case "idle":
					return "waiting";
				case "done":
					return "done";
			}
		};

		const walk = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
			const node = this.agents.get(id)!;
			const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
			const label = isRoot ? id : id.slice(0, 8);
			lines.push(`${prefix}${connector}${label}  ${formatStatus(node)}`);

			const kids = children.get(id) ?? [];
			const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
			for (let i = 0; i < kids.length; i++) {
				walk(kids[i], childPrefix, i === kids.length - 1, false);
			}
		};

		walk(rootId, "", true, true);
		return lines;
	}
}

async function runArcgeneral(opts: {
	task: string;
	context?: boolean;
	contextMessages?: Array<{ role: string; content: string }>;
	model?: string;
	provider?: string;
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	tokenRefresher?: () => Promise<string | undefined>;
	onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}): Promise<ArcgeneralResult> {
	const bin = resolveArcgeneralBin();
	const args: string[] = ["--json"];

	if (opts.model) args.push("--model", opts.model);
	if (opts.provider) args.push("--provider", opts.provider);

	let contextFile: string | null = null;
	if (opts.context && opts.contextMessages && opts.contextMessages.length > 0) {
		contextFile = writeContextFile(opts.contextMessages);
		args.push("--context", contextFile);
	}

	args.push(opts.task);
	let authProvider: string | null = null;
	let refreshInterval: ReturnType<typeof setInterval> | null = null;
	if (opts.tokenRefresher && opts.provider) {
		const initialToken = await opts.tokenRefresher();
		if (!initialToken) {
			return {
				result: null,
				error: `Could not obtain API key for ${opts.provider}. Check your login status or set the appropriate environment variable.`,
				exitCode: 1,
				stderr: "",
			};
		}
		authProvider = opts.provider;
		writeAuthFile(authProvider, initialToken);
		refreshInterval = setInterval(async () => {
			try {
				const newToken = await opts.tokenRefresher!();
				if (newToken && authProvider) {
					writeAuthFile(authProvider, newToken);
				}
			} catch {
				/* refresh failed, subprocess keeps using last good token */
			}
		}, 240_000);
	}

	return new Promise<ArcgeneralResult>((resolve) => {
		const proc = spawn(bin, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";
		let hasExited = false;
		let killTimer: ReturnType<typeof setTimeout> | null = null;

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			for (const line of data.toString().split("\n")) {
				if (!line) continue;
				try {
					const event = JSON.parse(line);
					if (event.type && opts.onEvent) {
						opts.onEvent(event);
					} else {
						stderr += line + "\n";
					}
				} catch {
					stderr += line + "\n";
				}
			}
		});

		const cleanup = () => {
			if (refreshInterval) {
				clearInterval(refreshInterval);
				refreshInterval = null;
			}
			if (authProvider) {
				removeAuthEntry(authProvider);
			}
			if (contextFile) {
				try {
					fs.unlinkSync(contextFile);
				} catch {
					/* ignore */
				}
				try {
					fs.rmdirSync(path.dirname(contextFile));
				} catch {
					/* ignore */
				}
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
					error: code !== 0 ? stderr.trim() || `Process exited with code ${code}` : null,
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
		const timeoutMs = (opts.timeout ?? 3600) * 1000;
		const timer = setTimeout(() => {
			if (!hasExited) {
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!hasExited) {
						try {
							proc.kill("SIGKILL");
						} catch {
							/* already dead */
						}
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
							try {
								proc.kill("SIGKILL");
							} catch {
								/* already dead */
							}
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
		description:
			"The task to delegate. Must be self-contained — include all necessary context, file paths, and expected output format.",
	}),
	context: Type.Optional(
		Type.Boolean({
			description:
				"If true, include the conversation history from the current session " +
				"so the agent understands what has been discussed. Only use when the " +
				"task references prior conversation. Default: false.",
		}),
	),
});

// ─── Extension entry point ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const toolDescription = `Delegate a task to an arcgeneral agent - a recursive LLM agent with a persistent IPython REPL.
Use this tool for complex tasks that require deep, extended work - especially when the task would consume too much context window if done inline. Arcgeneral handles arbitrarily long contexts by working recursively, decomposing problems and managing its own context across rounds.

Use subagents for simpler tasks that fit comfortably in a single context window.
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
			const contextMessages = params.context ? extractConversationContext(ctx) : undefined;
			const llmConfig = await resolveLLMConfig(ctx);
			const result = await runArcgeneral({
				task: params.task,
				context: params.context,
				contextMessages,
				model: llmConfig.model,
				provider: llmConfig.provider,
				tokenRefresher: llmConfig.tokenRefresher,
				cwd: ctx.cwd,
				signal,
			});

			if (result.error) {
				throw new Error(result.error);
			}

			const output = result.result || "(no output)";
			const { text } = truncateOutput(output);

			return {
				content: [{ type: "text" as const, text }],
				details: undefined as unknown,
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

			// Bridge the conversation context and LLM config
			const contextMessages = extractConversationContext(ctx);
			const llmConfig = await resolveLLMConfig(ctx);
			const tree = new AgentTree();
			ctx.ui.setStatus("arcgeneral", "arcgeneral: starting...");
			const result = await runArcgeneral({
				task,
				context: true,
				contextMessages,
				provider: llmConfig.provider,
				model: llmConfig.model,
				tokenRefresher: llmConfig.tokenRefresher,
				cwd: ctx.cwd,
				onEvent(event) {
					tree.handleEvent(event);
					ctx.ui.setStatus("arcgeneral", tree.renderStatus());
					if (tree.hasSubAgents()) {
						ctx.ui.setWidget("arcgeneral", tree.renderTree(), { placement: "belowEditor" });
					}
				},
			});
			ctx.ui.setStatus("arcgeneral", undefined);
			ctx.ui.setWidget("arcgeneral", undefined);

			if (result.error) {
				pi.sendMessage({
					customType: "arcgeneral-result",
					content: `arcgeneral error: ${result.error}`,
					display: true,
				});
			} else {
				const output = result.result || "(no output)";
				const { text } = truncateOutput(output);

				// Inject the result back into the conversation as a steer message
				// so the LLM sees it and can summarize/act on it.
				pi.sendUserMessage(`[arcgeneral result for task: "${task}"]\n\n${text}`, { deliverAs: "steer" });
			}
		},
	});
}
