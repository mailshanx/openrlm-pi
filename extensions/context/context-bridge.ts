import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ContextFileHandle {
	path: string;
	cleanup(): void;
}

export function createContextFile(messages: Array<{ role: string; content: string }>): ContextFileHandle {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openrlm-context-"));
	const filePath = path.join(tmpDir, "context.json");
	fs.writeFileSync(filePath, JSON.stringify(messages), "utf-8");

	return {
		path: filePath,
		cleanup(): void {
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {
				/* ignore cleanup failures */
			}
		},
	};
}
