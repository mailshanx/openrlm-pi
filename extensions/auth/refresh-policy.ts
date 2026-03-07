import type { RefreshPolicy } from "../types";

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;

export function defaultRefreshPolicy(): RefreshPolicy {
	return { intervalMs: DEFAULT_REFRESH_INTERVAL_MS };
}
