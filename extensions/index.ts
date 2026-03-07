/**
 * openrlm Extension for pi
 *
 * Registers:
 * - `openrlm` tool: LLM can delegate data analysis, multi-step computation,
 *   and persistent-REPL tasks to an openrlm agent process.
 * - `/task` command: user can explicitly delegate a task via the command line.
 *
 * Each invocation spawns a fresh `openrlm --json` process with optional
 * conversation context bridged from pi's session history.
 *
 * Prerequisites:
 *   uv tool install openrlm          # or pip install openrlm
 *   # Pi auth is bridged automatically for supported providers (anthropic, openai-codex).
 *   # For default OpenRouter mode: export OPENROUTER_API_KEY=...
 */

import { type ExtensionAPI, type ExtensionContext, type Theme, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createAuthBridgeSession } from "./auth/bridge-session";
import { resolveBridgeTarget } from "./auth/provider-adapters";
import { defaultRefreshPolicy } from "./auth/refresh-policy";
import { PiTokenSource } from "./auth/token-source";
import { runOpenrlm, type OpenrlmResult } from "./process/openrlm-runner";
import type { AuthBridgeSession, ResolvedBridgeTarget } from "./types";

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const CONTEXT_MAX_ENTRIES = 200;

// ─── Context bridging ───────────────────────────────────────────────────

/**
 * Extract user/assistant message pairs from pi's session entries.
 * Drops tool messages, system messages, and other entry types.
 * Returns a JSON-serializable array for openrlm's --context flag.
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

// ─── Activity tracking (Layer 1: pure data model) ──────────────────────

/** A recorded event in an agent's activity timeline. */
type ActivityEntry =
	| { kind: "code"; code: string }
	| { kind: "code_done"; toolName: string; elapsedSeconds: number }
	| { kind: "model_response"; model: string; promptTokens: number; completionTokens: number }
	| { kind: "task_started"; taskId: string; task: string }
	| { kind: "task_completed"; taskId: string };

/** Per-agent state accumulated from events. */
interface AgentState {
	parentId: string;
	depth: number;
	status: "idle" | "running" | "done";
	round: number;
	maxRounds: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalElapsedSeconds: number;
	roundsCompleted: number;
	activity: ActivityEntry[];
}

/** Session-level aggregate statistics. */
interface SessionStats {
	totalPromptTokens: number;
	totalCompletionTokens: number;
	totalElapsedSeconds: number;
	startTime: number;
}

/**
 * Pure state machine that accumulates openrlm events into structured state.
 * No rendering, no pi API calls — just data.
 */
class ActivityTracker {
	private agents = new Map<string, AgentState>();
	private _children = new Map<string, string[]>();
	private _rootId: string | undefined;
	private _activeId = "main";
	private _version = 0;
	private _sessionStats: SessionStats = {
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		totalElapsedSeconds: 0,
		startTime: Date.now(),
	};

	/** Monotonically increasing counter, bumped on every event. */
	get version(): number {
		return this._version;
	}

	/** Process a raw event from openrlm's stderr JSONL stream. */
	handleEvent(event: { type: string; [key: string]: unknown }): void {
		const id = event.agent_id as string;
		this._version++;
		switch (event.type) {
			case "AgentCreated": {
				const parentId = event.parent_id as string;
				this.agents.set(id, {
					parentId,
					depth: event.depth as number,
					status: "idle",
					round: 0,
					maxRounds: 0,
					totalPromptTokens: 0,
					totalCompletionTokens: 0,
					totalElapsedSeconds: 0,
					roundsCompleted: 0,
					activity: [],
				});
				// Maintain parent→children index
				const siblings = this._children.get(parentId);
				if (siblings) siblings.push(id);
				else this._children.set(parentId, [id]);
				break;
			}
			case "RoundStart": {
				if (!this.agents.has(id)) {
					// Auto-create root agent on first event
					this.agents.set(id, {
						parentId: "",
						depth: 0,
						status: "running",
						round: 0,
						maxRounds: 0,
						totalPromptTokens: 0,
						totalCompletionTokens: 0,
						totalElapsedSeconds: 0,
						roundsCompleted: 0,
						activity: [],
					});
					this._rootId = id;
				}
				const node = this.agents.get(id)!;
				node.round = (event.round_num as number) + 1;
				node.maxRounds = event.max_rounds as number;
				node.status = "running";
				this._activeId = id;
				if (!this._rootId) this._rootId = id;
				break;
			}
			case "ModelResponse": {
				const node = this.agents.get(id);
				if (!node) break;
				const pt = (event.prompt_tokens as number | null) ?? 0;
				const ct = (event.completion_tokens as number | null) ?? 0;
				node.totalPromptTokens += pt;
				node.totalCompletionTokens += ct;
				this._sessionStats.totalPromptTokens += pt;
				this._sessionStats.totalCompletionTokens += ct;
				node.activity.push({
					kind: "model_response",
					model: event.model as string,
					promptTokens: pt,
					completionTokens: ct,
				});
				break;
			}
			case "ToolExecStart": {
				const node = this.agents.get(id);
				if (node) {
					node.activity.push({ kind: "code", code: event.code as string });
				}
				break;
			}
			case "ToolExecEnd": {
				const node = this.agents.get(id);
				if (node) {
					const elapsed = event.elapsed_seconds as number;
					node.totalElapsedSeconds += elapsed;
					this._sessionStats.totalElapsedSeconds += elapsed;
					node.activity.push({
						kind: "code_done",
						toolName: event.tool_name as string,
						elapsedSeconds: elapsed,
					});
				}
				break;
			}
			case "TaskStarted": {
				const node = this.agents.get(id);
				if (node) {
					node.status = "running";
					node.activity.push({
						kind: "task_started",
						taskId: event.task_id as string,
						task: event.task as string,
					});
				}
				break;
			}
			case "TaskCompleted": {
				const node = this.agents.get(id);
				if (node) {
					node.status = "done";
					node.activity.push({
						kind: "task_completed",
						taskId: event.task_id as string,
					});
				}
				break;
			}
			case "TurnEnd": {
				const node = this.agents.get(id);
				if (node) {
					node.roundsCompleted = event.rounds as number;
				}
				break;
			}
		}
	}

	getAgents(): ReadonlyMap<string, Readonly<AgentState>> {
		return this.agents;
	}

	getChildren(): ReadonlyMap<string, readonly string[]> {
		return this._children;
	}

	getRootId(): string | undefined {
		return this._rootId;
	}

	getActiveAgentId(): string {
		return this._activeId;
	}

	getSessionStats(): Readonly<SessionStats> {
		return this._sessionStats;
	}
	hasSubAgents(): boolean {
		return this.agents.size > 1;
	}

	/** Mark all agents as done. Called when the openrlm process exits. */
	markComplete(): void {
		this._version++;
		for (const [, agent] of this.agents) {
			if (agent.status !== "done") agent.status = "done";
		}
	}
}

// ─── Widget rendering (Layer 2: stateless render from tracker state) ────

const MAX_TREE_LINES = 25;
const MAX_CODE_LINES = 4;
/**
 * Details payload for the openrlm tool's onUpdate / renderResult.
 *
 * Every field is a primitive or plain object — no class instances, no Maps.
 * This ensures details survive JSON.stringify → JSON.parse roundtrip when
 * the session is persisted and replayed.
 */
interface OpenrlmDetails {
	/** The original task prompt, for display in expanded view. */
	task: string;
	/** The openrlm agent's final output text. */
	output: string | null;
	/** Error message, if the run failed. */
	error: string | null;
	/** Pre-rendered agent tree lines, snapshot at completion (null if single-agent). */
	agentTree: string[] | null;
	/** Aggregate session statistics, null until first model response. */
	stats: {
		agentCount: number;
		totalPromptTokens: number;
		totalCompletionTokens: number;
		wallSeconds: number;
	} | null;
}

function formatTokenCount(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${Math.round(seconds)}s`;
	const mins = Math.floor(seconds / 60);
	const secs = Math.round(seconds % 60);
	return `${mins}m${secs}s`;
}

/** Build the footer status line shown in pi's status bar. */
function formatStatusLine(tracker: ActivityTracker): string {
	const rootId = tracker.getRootId();
	if (!rootId) return "openrlm: starting...";
	const agents = tracker.getAgents();
	const active = agents.get(tracker.getActiveAgentId());
	if (!active) return "openrlm: starting...";
	const stats = tracker.getSessionStats();

	const parts = [`openrlm: round ${active.round}/${active.maxRounds}`];
	if (agents.size > 1) parts[0] = `openrlm: ${agents.size} agents, round ${active.round}/${active.maxRounds}`;
	if (stats.totalPromptTokens > 0) {
		parts.push(`${formatTokenCount(stats.totalPromptTokens)}↑ ${formatTokenCount(stats.totalCompletionTokens)}↓`);
	}
	if (stats.totalElapsedSeconds > 1) {
		parts.push(`⏱ ${formatElapsed(stats.totalElapsedSeconds)}`);
	}
	return parts.join("  ");
}

/** Get the last code snippet from an agent's activity log. */
function getLastCode(agent: Readonly<AgentState>): string | null {
	for (let i = agent.activity.length - 1; i >= 0; i--) {
		const entry = agent.activity[i];
		if (entry.kind === "code") return entry.code;
	}
	return null;
}

/** Get the task description for a sub-agent. */
function getTaskDescription(agent: Readonly<AgentState>): string | null {
	for (const entry of agent.activity) {
		if (entry.kind === "task_started") return entry.task;
	}
	return null;
}

/** Truncate a code string to N lines, clipping long lines to fit width. */
function truncateCode(code: string, maxLines: number, maxWidth: number): string[] {
	const lines = code.split("\n").filter((l) => l.trim() !== "");
	const result: string[] = [];
	for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
		const line = lines[i];
		result.push(line.length > maxWidth ? line.slice(0, maxWidth - 1) + "…" : line);
	}
	if (lines.length > maxLines) {
		result.push(`... +${lines.length - maxLines} lines`);
	}
	return result;
}

/** Format the status badge for an agent node. */
function formatNodeStatus(agent: Readonly<AgentState>, theme: Theme): string {
	switch (agent.status) {
		case "running":
			return theme.fg("accent", `● round ${agent.round}/${agent.maxRounds}`);
		case "idle":
			return theme.fg("muted", "○ waiting");
		case "done": {
			const parts = ["✓ done"];
			if (agent.roundsCompleted > 0) parts.push(`${agent.roundsCompleted} rounds`);
			if (agent.totalElapsedSeconds > 1) parts.push(`⏱ ${formatElapsed(agent.totalElapsedSeconds)}`);
			return theme.fg("success", parts.join("  "));
		}
	}
}

/**
 * Render the agent tree with activity annotations into an array of styled strings.
 *
 * Truncation is structure-aware: agent header lines (the tree skeleton) are always
 * shown. Activity annotations (code previews, task descriptions) absorb truncation.
 * Running agents split the annotation budget equally (capped at MAX_CODE_LINES each);
 * done agents share what remains.
 */
function renderAgentTree(tracker: ActivityTracker, theme: Theme, width: number): string[] {
	const rootId = tracker.getRootId();
	if (!rootId) return [theme.fg("muted", "  openrlm: starting...")];

	const agents = tracker.getAgents();
	const children = tracker.getChildren();

	// Budget: headers are sacred (1 per agent), footer takes 1 line, rest is for annotations.
	const nodeCount = agents.size;
	const totalAnnotationBudget = Math.max(0, MAX_TREE_LINES - nodeCount - 1);

	// Count running agents to divide annotation budget fairly among them.
	let runningCount = 0;
	for (const [, agent] of agents) {
		if (agent.status === "running") runningCount++;
	}
	// Each running agent gets an equal share of the budget, capped at MAX_CODE_LINES.
	const perRunningBudget =
		runningCount > 0 ? Math.min(MAX_CODE_LINES, Math.floor(totalAnnotationBudget / runningCount)) : 0;
	// Done agents share whatever is left after running agents.
	let doneAnnotationBudget = Math.max(0, totalAnnotationBudget - perRunningBudget * runningCount);

	const lines: string[] = [];

	const walk = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
		const agent = agents.get(id);
		if (!agent) return;

		// Header line — always emitted (this IS the tree structure)
		const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
		const label = isRoot ? theme.bold(id) : theme.bold(id.slice(0, 8));
		const status = formatNodeStatus(agent, theme);
		lines.push(`${prefix}${connector}${label}  ${status}`);

		// Activity annotation — only if budget allows
		const continuationPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
		const codeLinePrefix = continuationPrefix + theme.fg("muted", "│ ");

		if (agent.status === "running" && perRunningBudget > 0) {
			const code = getLastCode(agent);
			if (code) {
				const availableWidth = Math.max(20, width - continuationPrefix.length - 4);
				const codeLines = truncateCode(code, perRunningBudget, availableWidth);
				for (const cl of codeLines) {
					lines.push(`${codeLinePrefix}${theme.fg("dim", cl)}`);
				}
			}
		} else if (agent.status === "done" && !isRoot && doneAnnotationBudget > 0) {
			const task = getTaskDescription(agent);
			if (task) {
				const preview = task.length > 80 ? task.slice(0, 79) + "…" : task;
				lines.push(`${codeLinePrefix}${theme.fg("dim", preview)}`);
				doneAnnotationBudget--;
			}
		}

		// Recurse into children
		const kids = children.get(id) ?? [];
		const childPrefix = isRoot ? "" : continuationPrefix;
		for (let i = 0; i < kids.length; i++) {
			walk(kids[i], childPrefix, i === kids.length - 1, false);
		}
	};

	walk(rootId, "", true, true);

	// Session summary footer
	const stats = tracker.getSessionStats();
	if (stats.totalPromptTokens > 0) {
		const elapsed = (Date.now() - stats.startTime) / 1000;
		const summary = theme.fg(
			"muted",
			`tokens: ${formatTokenCount(stats.totalPromptTokens)}↑ ${formatTokenCount(stats.totalCompletionTokens)}↓` +
				(elapsed > 5 ? `  wall: ${formatElapsed(elapsed)}` : ""),
		);
		lines.push(summary);
	}

	return lines;
}

/** Format stats from serializable details (works identically on live and replayed sessions). */
function formatDetailsStats(details: OpenrlmDetails | undefined, theme: Theme): string {
	if (!details?.stats) return "";
	const { stats } = details;
	const parts: string[] = [];
	if (stats.agentCount > 1) parts.push(`${stats.agentCount} agents`);
	if (stats.totalPromptTokens > 0) {
		parts.push(`${formatTokenCount(stats.totalPromptTokens)}↑ ${formatTokenCount(stats.totalCompletionTokens)}↓`);
	}
	if (stats.wallSeconds > 1) parts.push(`⏱ ${formatElapsed(stats.wallSeconds)}`);
	return parts.length > 0 ? theme.fg("dim", parts.join("  ")) : "";
}

/**
 * Component that renders the openrlm activity widget.
 * Reads from ActivityTracker on each render() call.
 * Version-based caching avoids redundant work when the TUI re-renders
 * but no new events have arrived.
 */
class OpenrlmWidget implements Component {
	private tracker: ActivityTracker;
	private theme: Theme;
	private cachedWidth: number | null = null;
	private cachedLines: string[] | null = null;
	private cachedVersion = -1;

	constructor(tracker: ActivityTracker, theme: Theme) {
		this.tracker = tracker;
		this.theme = theme;
	}

	invalidate(): void {
		this.cachedLines = null;
		this.cachedWidth = null;
		this.cachedVersion = -1;
	}

	render(width: number): string[] {
		const version = this.tracker.version;
		if (this.cachedLines && this.cachedWidth === width && this.cachedVersion === version) {
			return this.cachedLines;
		}
		const lines = renderAgentTree(this.tracker, this.theme, width);
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedVersion = version;
		return lines;
	}
}

/** Snapshot the tracker's current state into a serializable stats object. */
function snapshotStats(tracker: ActivityTracker): OpenrlmDetails["stats"] {
	const session = tracker.getSessionStats();
	if (session.totalPromptTokens === 0 && session.totalCompletionTokens === 0) return null;
	return {
		agentCount: tracker.getAgents().size,
		totalPromptTokens: session.totalPromptTokens,
		totalCompletionTokens: session.totalCompletionTokens,
		wallSeconds: Math.round((Date.now() - session.startTime) / 1000),
	};
}

/** Snapshot the agent tree into plain string lines (no ANSI — theming applied at render time). */
function snapshotAgentTree(tracker: ActivityTracker): string[] | null {
	if (!tracker.hasSubAgents()) return null;
	const agents = tracker.getAgents();
	const children = tracker.getChildren();
	const rootId = tracker.getRootId();
	if (!rootId) return null;

	const lines: string[] = [];

	const formatStatus = (agent: Readonly<AgentState>): string => {
		switch (agent.status) {
			case "running":
				return `round ${agent.round}/${agent.maxRounds}`;
			case "idle":
				return "waiting";
			case "done": {
				const parts = ["done"];
				if (agent.roundsCompleted > 0) parts.push(`${agent.roundsCompleted} rounds`);
				if (agent.totalElapsedSeconds > 1) parts.push(formatElapsed(agent.totalElapsedSeconds));
				return parts.join("  ");
			}
		}
	};

	const walk = (id: string, prefix: string, isLast: boolean, isRoot: boolean) => {
		const agent = agents.get(id);
		if (!agent) return;
		const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
		const label = isRoot ? id : id.slice(0, 8);
		lines.push(`${prefix}${connector}${label}  ${formatStatus(agent)}`);
		const kids = children.get(id) ?? [];
		const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
		for (let i = 0; i < kids.length; i++) {
			walk(kids[i], childPrefix, i === kids.length - 1, false);
		}
	};

	walk(rootId, "", true, true);
	return lines;
}

async function runOpenrlmWithPiAuth(opts: {
	ctx: ExtensionContext;
	task: string;
	context?: boolean;
	contextMessages?: Array<{ role: string; content: string }>;
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}): Promise<OpenrlmResult> {
	const target: ResolvedBridgeTarget | undefined = resolveBridgeTarget(opts.ctx);
	let bridgeSession: AuthBridgeSession | undefined;

	if (target) {
		bridgeSession = createAuthBridgeSession({
			target,
			tokenSource: new PiTokenSource(opts.ctx),
			refreshPolicy: defaultRefreshPolicy(),
		});
		await bridgeSession.start();
	}

	try {
		return await runOpenrlm({
			task: opts.task,
			context: opts.context,
			contextMessages: opts.contextMessages,
			model: target?.model,
			provider: target?.bridgeProvider,
			cwd: opts.cwd,
			signal: opts.signal,
			timeout: opts.timeout,
			env: bridgeSession?.env,
			onEvent: opts.onEvent,
		});
	} finally {
		await bridgeSession?.stop();
	}
}

// ─── Tool schema ────────────────────────────────────────────────────────

const OpenrlmParams = Type.Object({
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
	const toolDescription = `Delegate a task to an openrlm agent - a recursive LLM agent with a persistent IPython REPL.
Use this tool for complex tasks that require deep, extended work - especially when the task would consume too much context window if done inline. Openrlm handles arbitrarily long contexts by working recursively, decomposing problems and managing its own context across rounds.

Use subagents for simpler tasks that fit comfortably in a single context window.
The task prompt must be self-contained. The agent cannot see your conversation unless you set context=true.`;

	// ─── Register the openrlm tool ────────────────────────────────

	pi.registerTool({
		name: "openrlm",
		label: "Openrlm",
		description: toolDescription,
		parameters: OpenrlmParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const contextMessages = params.context ? extractConversationContext(ctx) : undefined;
			const tracker = new ActivityTracker();
			const result = await runOpenrlmWithPiAuth({
				ctx,
				task: params.task,
				context: params.context,
				contextMessages,
				cwd: ctx.cwd,
				signal,
				onEvent(event) {
					tracker.handleEvent(event);
					const statusLine = formatStatusLine(tracker);
					// Streaming details: snapshot current tree for isPartial rendering
					const streamingDetails: OpenrlmDetails = {
						task: params.task,
						output: null,
						error: null,
						agentTree: snapshotAgentTree(tracker),
						stats: snapshotStats(tracker),
					};
					onUpdate?.({
						content: [{ type: "text", text: statusLine }],
						details: streamingDetails,
					});
					ctx.ui.setStatus("openrlm", statusLine);
				},
			});
			tracker.markComplete();
			ctx.ui.setStatus("openrlm", undefined);
			if (result.error) {
				throw new Error(result.error);
			}
			const output = result.result || "(no output)";
			const { text } = truncateOutput(output);
			// Final details: snapshot completed state for persistence
			const finalDetails: OpenrlmDetails = {
				task: params.task,
				output: output,
				error: null,
				agentTree: snapshotAgentTree(tracker),
				stats: snapshotStats(tracker),
			};
			return {
				content: [{ type: "text" as const, text }],
				details: finalDetails,
			};
		},

		renderCall(args, theme) {
			const maxChars = 300;
			const taskText = args.task.length > maxChars ? args.task.slice(0, maxChars - 1) + "\u2026" : args.task;
			const header = theme.fg("toolTitle", theme.bold("openrlm"));
			return new Text(`${header}\n${theme.fg("dim", taskText)}`, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as OpenrlmDetails | undefined;
			const output =
				details?.output ?? (result.content[0]?.type === "text" ? result.content[0].text : null) ?? "(no output)";
			const mdTheme = getMarkdownTheme();

			// ── Streaming: show live agent tree ──
			if (isPartial) {
				if (details?.agentTree) {
					return new Text(details.agentTree.join("\n"), 0, 0);
				}
				const statusText = result.content[0]?.type === "text" ? result.content[0].text : "openrlm: running...";
				return new Text(theme.fg("muted", statusText), 0, 0);
			}

			// ── Stats summary line (shared by collapsed & expanded) ──
			const statsLine = formatDetailsStats(details, theme);

			// ── Error ──
			if (details?.error) {
				let errText = theme.fg("error", `Error: ${details.error}`);
				if (statsLine) errText += "\n" + statsLine;
				return new Text(errText, 0, 0);
			}

			// ── Collapsed: one-line summary ──
			if (!expanded) {
				const icon = theme.fg("success", "\u2713");
				const firstLine = output.split("\n")[0];
				const previewText = firstLine.length > 120 ? firstLine.slice(0, 119) + "\u2026" : firstLine;
				let line = `${icon} ${theme.fg("toolTitle", theme.bold("done"))}  ${theme.fg("dim", previewText)}`;
				if (statsLine) line += "\n" + statsLine;
				return new Text(line, 0, 0);
			}

			// ── Expanded: task + agent tree + markdown output + stats ──
			const box = new Box(0, 0);

			// Task prompt
			if (details?.task) {
				const taskPreview = details.task.length > 500 ? details.task.slice(0, 499) + "\u2026" : details.task;
				box.addChild(new Text(theme.fg("muted", "\u25B6 " + taskPreview), 0, 0));
			}

			// Agent tree
			if (details?.agentTree) {
				box.addChild(new Text(details.agentTree.join("\n"), 0, 0));
			}

			// Output with markdown rendering
			box.addChild(new Markdown(output, 0, 0, mdTheme));

			// Stats
			if (statsLine) {
				box.addChild(new Text(statsLine, 0, 0));
			}

			return box;
		},
	});

	// ─── Register the /task command ─────────────────────────────────
	pi.registerCommand("task", {
		description: "Delegate a task to openrlm (persistent IPython REPL agent)",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /task <description of the task>", "error");
				return;
			}

			// Bridge the conversation context through Pi and run with the active provider.
			const contextMessages = extractConversationContext(ctx);
			const tracker = new ActivityTracker();
			// Own our cancellation lifecycle — pi's command API doesn't provide a signal.
			// Listen for bare Escape (\x1b) and abort the subprocess via standard AbortController.
			const abort = new AbortController();
			const cancelHint = "(Escape to cancel)";
			const unsubscribe = ctx.ui.onTerminalInput((data) => {
				if (data === "\x1b") {
					abort.abort();
					return { consume: true };
				}
			});
			// Install the widget component once — it reads from the tracker on each render.
			// setStatus() calls on each event trigger requestRender(), which calls
			// our component's render(), which reads the latest tracker state.
			ctx.ui.setStatus("openrlm", `openrlm: starting...  ${cancelHint}`);
			ctx.ui.setWidget("openrlm", (_tui, theme) => new OpenrlmWidget(tracker, theme), {
				placement: "belowEditor",
			});

			try {
				const result = await runOpenrlmWithPiAuth({
					ctx,
					task,
					context: true,
					contextMessages,
					cwd: ctx.cwd,
					signal: abort.signal,
					onEvent(event) {
						tracker.handleEvent(event);
						ctx.ui.setStatus("openrlm", `${formatStatusLine(tracker)}  ${cancelHint}`);
					},
				});
				tracker.markComplete();
				if (abort.signal.aborted) {
					const stats = tracker.getSessionStats();
					const parts: string[] = ["openrlm task cancelled"];
					const elapsed = Math.round((Date.now() - stats.startTime) / 1000);
					const agents = tracker.getAgents();
					const totalRounds = Array.from(agents.values()).reduce((sum, a) => sum + a.roundsCompleted, 0);
					if (totalRounds > 0 || elapsed > 0) {
						const detail: string[] = [];
						if (totalRounds > 0) detail.push(`${totalRounds} round${totalRounds !== 1 ? "s" : ""} completed`);
						if (elapsed > 0) detail.push(formatElapsed(elapsed));
						parts.push(`(${detail.join(", ")})`);
					}
					pi.sendMessage({
						customType: "openrlm-result",
						content: parts.join(" "),
						display: true,
					});
				} else if (result.error) {
					pi.sendMessage({
						customType: "openrlm-result",
						content: `openrlm error: ${result.error}`,
						display: true,
					});
				} else {
					const output = result.result || "(no output)";
					const { text } = truncateOutput(output);

					// Inject the result back into the conversation as a steer message
					// so the LLM sees it and can summarize/act on it.
					pi.sendUserMessage(`[openrlm result for task: "${task}"]\n\n${text}`, { deliverAs: "steer" });
				}
			} finally {
				unsubscribe();
				ctx.ui.setStatus("openrlm", undefined);
				ctx.ui.setWidget("openrlm", undefined);
			}
		},
	});
}
