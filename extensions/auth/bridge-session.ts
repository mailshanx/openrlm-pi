import type { AuthBridgeSession, CreateAuthBridgeSessionOptions } from "../types";
import { createBridgeAuthFile, type BridgeAuthFile } from "./bridge-file";

class OpenrlmAuthBridgeSession implements AuthBridgeSession {
	private bridgeFile: BridgeAuthFile | null = null;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private lastToken: string | null = null;
	private refreshInFlight: Promise<void> | null = null;
	private started = false;

	constructor(private readonly options: CreateAuthBridgeSessionOptions) {}

	get env(): Record<string, string> {
		if (!this.bridgeFile) return {};
		return { OPENRLM_AUTH_FILE: this.bridgeFile.path };
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		const initialToken = await this.options.tokenSource.getAccessToken(this.options.target.bridgeProvider);
		if (!initialToken) {
			throw new Error(
				`Could not obtain API key for ${this.options.target.bridgeProvider}. ` +
					`Check your login status or set the appropriate environment variable.`,
			);
		}

		this.bridgeFile = createBridgeAuthFile();
		this.bridgeFile.write(this.options.target.bridgeProvider, initialToken);
		this.lastToken = initialToken;

		this.refreshTimer = setInterval(() => {
			void this.refresh().catch(() => {
				/* refresh failures are tolerated; keep last good token */
			});
		}, this.options.refreshPolicy.intervalMs);
	}

	async stop(): Promise<void> {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.refreshInFlight) {
			try {
				await this.refreshInFlight;
			} catch {
				/* ignore */
			}
			this.refreshInFlight = null;
		}
		if (this.bridgeFile) {
			this.bridgeFile.cleanup();
			this.bridgeFile = null;
		}
		this.lastToken = null;
		this.started = false;
	}

	private async refresh(): Promise<void> {
		if (!this.bridgeFile) return;
		if (this.refreshInFlight) {
			await this.refreshInFlight;
			return;
		}

		this.refreshInFlight = (async () => {
			const token = await this.options.tokenSource.getAccessToken(this.options.target.bridgeProvider);
			if (!token || !this.bridgeFile) return;
			if (token === this.lastToken) return;
			this.bridgeFile.write(this.options.target.bridgeProvider, token);
			this.lastToken = token;
		})();

		try {
			await this.refreshInFlight;
		} finally {
			this.refreshInFlight = null;
		}
	}
}

export function createAuthBridgeSession(options: CreateAuthBridgeSessionOptions): AuthBridgeSession {
	return new OpenrlmAuthBridgeSession(options);
}
