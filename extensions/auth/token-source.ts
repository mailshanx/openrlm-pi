import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BridgeProviderId, TokenSource } from "../types";

export class PiTokenSource implements TokenSource {
	constructor(private readonly ctx: ExtensionContext) {}

	async getAccessToken(provider: BridgeProviderId): Promise<string | undefined> {
		return this.ctx.modelRegistry.getApiKeyForProvider(provider);
	}
}
