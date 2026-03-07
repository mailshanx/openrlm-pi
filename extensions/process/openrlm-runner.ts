import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContextFile } from "../context/context-bridge";

function resolveOpenrlmBin(): string {
	const envBin = process.env.OPENRLM_BIN;
	if (envBin) return envBin;

	const uvToolBin = path.join(os.homedir(), ".local", "bin", "openrlm");
	if (fs.existsSync(uvToolBin)) return uvToolBin;

	return "openrlm";
}

export interface OpenrlmResult {
	result: string | null;
	error: string | null;
	exitCode: number;
	stderr: string;
}

export interface RunOpenrlmOptions {
	task: string;
	context?: boolean;
	contextMessages?: Array<{ role: string; content: string }>;
	model?: string;
	provider?: string;
	cwd: string;
	signal?: AbortSignal;
	timeout?: number;
	env?: Record<string, string>;
	onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

export async function runOpenrlm(opts: RunOpenrlmOptions): Promise<OpenrlmResult> {
	const bin = resolveOpenrlmBin();
	const args: string[] = ["--json"];

	if (opts.model) args.push("--model", opts.model);
	if (opts.provider) args.push("--provider", opts.provider);

	let contextHandle: ReturnType<typeof createContextFile> | null = null;
	if (opts.context && opts.contextMessages && opts.contextMessages.length > 0) {
		contextHandle = createContextFile(opts.contextMessages);
		args.push("--context", contextHandle.path);
	}

	args.push(opts.task);

	return new Promise<OpenrlmResult>((resolve) => {
		const proc = spawn(bin, args, {
			cwd: opts.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...opts.env },
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
			contextHandle?.cleanup();
			contextHandle = null;
		};

		proc.on("close", (code) => {
			hasExited = true;
			if (killTimer) clearTimeout(killTimer);
			cleanup();

			try {
				const parsed = JSON.parse(stdout.trim());
				resolve({
					result: parsed.result ?? null,
					error: parsed.error ?? null,
					exitCode: code ?? 0,
					stderr,
				});
			} catch {
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
					error: `openrlm not found. Install with: uv tool install openrlm\n(or set OPENRLM_BIN to the binary path)`,
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
