import type { SearchMode } from "./types.ts";

export const SEARCH_MODES: readonly SearchMode[] = ["search", "vsearch", "query"];

/** Validate modes at CLI and other untyped boundaries. */
export function isSearchMode(value: unknown): value is SearchMode {
	return SEARCH_MODES.some((mode) => mode === value);
}
