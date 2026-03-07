import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { OpenrlmAuthAdapter, ResolvedBridgeTarget } from "../types";

const ADAPTERS: OpenrlmAuthAdapter[] = [
	{ piProvider: "anthropic", bridgeProvider: "anthropic" },
	{ piProvider: "openai-codex", bridgeProvider: "openai-codex" },
];

export function resolveBridgeTarget(ctx: ExtensionContext): ResolvedBridgeTarget | undefined {
	const model = ctx.model;
	if (!model) return undefined;

	const adapter = ADAPTERS.find((candidate) => candidate.piProvider === model.provider);
	if (!adapter) return undefined;

	return {
		bridgeProvider: adapter.bridgeProvider,
		model: adapter.mapModel ? adapter.mapModel(model.id) : model.id,
	};
}
