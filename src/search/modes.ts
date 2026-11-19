import { DEFAULT_STRATEGIES } from "./strategies.ts";

export const SEARCH_MODES: readonly string[] = Object.keys(DEFAULT_STRATEGIES);

/** Validate modes at CLI and other untyped boundaries. */
export function isSearchMode(value: unknown): value is string {
	return SEARCH_MODES.some((mode) => mode === value);
}
