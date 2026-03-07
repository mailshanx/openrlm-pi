export type BridgeProviderId = "anthropic" | "openai-codex";

export interface OpenrlmAuthAdapter {
	/** Pi provider this adapter matches */
	piProvider: string;
	/** Provider key expected by openrlm auth resolution */
	bridgeProvider: BridgeProviderId;
	/** Optional model ID mapping from Pi model IDs to openrlm model IDs */
	mapModel?: (piModelId: string) => string;
}

export interface ResolvedBridgeTarget {
	bridgeProvider: BridgeProviderId;
	model?: string;
}

export interface TokenSource {
	getAccessToken(provider: BridgeProviderId): Promise<string | undefined>;
}

export interface RefreshPolicy {
	/** refresh interval in milliseconds */
	intervalMs: number;
}

export interface AuthBridgeSession {
	readonly env: Record<string, string>;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export interface CreateAuthBridgeSessionOptions {
	target: ResolvedBridgeTarget;
	tokenSource: TokenSource;
	refreshPolicy: RefreshPolicy;
}
