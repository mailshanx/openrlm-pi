import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BridgeAuthFile {
	path: string;
	write(provider: string, token: string): void;
	cleanup(): void;
}

export function createBridgeAuthFile(): BridgeAuthFile {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-openrlm-auth-"));
	const authFilePath = path.join(tmpDir, "auth.json");

	const write = (provider: string, token: string): void => {
		const payload = JSON.stringify({ [provider]: token }, null, 2);
		const tmpPath = `${authFilePath}.tmp-${process.pid}-${Date.now()}`;
		fs.writeFileSync(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmpPath, authFilePath);
		try {
			fs.chmodSync(authFilePath, 0o600);
		} catch {
			/* best-effort permissions */
		}
	};

	const cleanup = (): void => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore cleanup failures */
		}
	};

	return { path: authFilePath, write, cleanup };
}
