import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { ipcClientMock } from "@test/mocks/ipc-client";
import type { OllamaLibraryHit, OllamaLibraryTag } from "@/shared/api/models";

// Per-test fakes so we can swap return values without re-mocking the module.
// `mock.module` is process-global under bun:test and never torn down — any
// partial shim leaks. Spread the complete IPC fake then override only what
// this suite controls.
interface CatalogResult {
	error?: string;
	hits: readonly OllamaLibraryHit[];
}

interface TagsResult {
	error?: string;
	model: string;
	tags: readonly OllamaLibraryTag[];
}

const catalogState: { value: CatalogResult } = { value: { hits: [] } };
const tagsState: { value: TagsResult } = { value: { model: "", tags: [] } };
const hitState: { value: OllamaLibraryHit } = { value: { name: "" } };
const callCounts = { catalog: 0, tags: 0, hit: 0 };

mock.module("@/shared/api/ipc-client", () => ({
	...ipcClientMock(),
	fetchOllamaLibraryCatalog: async () => {
		callCounts.catalog++;
		// Resolve on next microtask so concurrent calls overlap.
		await Promise.resolve();
		return catalogState.value;
	},
	fetchOllamaLibraryTags: async (model: string) => {
		callCounts.tags++;
		await Promise.resolve();
		return { ...tagsState.value, model };
	},
	fetchOllamaModelHit: async (model: string) => {
		callCounts.hit++;
		await Promise.resolve();
		return { ...hitState.value, name: hitState.value.name || model };
	},
}));

const {
	useOllamaLibraryStore,
	tagsCacheKey,
	hitCacheKey,
	shouldSkipCatalogLoad,
	shouldSkipTagsFetch,
	shouldSkipHitFetch,
} = await import("./ollama-library-store");

const INITIAL_STATE = useOllamaLibraryStore.getInitialState();

function resetStore(): void {
	useOllamaLibraryStore.setState(INITIAL_STATE, true);
	catalogState.value = { hits: [] };
	tagsState.value = { model: "", tags: [] };
	hitState.value = { name: "" };
	callCounts.catalog = 0;
	callCounts.tags = 0;
	callCounts.hit = 0;
}

afterEach(resetStore);
afterAll(resetStore);

describe("tagsCacheKey", () => {
	test("lowercases and trims the model name", () => {
		expect(tagsCacheKey("  Llama3:Latest  ")).toBe("llama3:latest");
	});

	test("returns empty string for whitespace-only input (signals skip)", () => {
		expect(tagsCacheKey("   ")).toBe("");
	});
});

describe("shouldSkipCatalogLoad", () => {
	test("true when already loaded", () => {
		expect(shouldSkipCatalogLoad({ isLoaded: true, isLoading: false })).toBe(
			true,
		);
	});

	test("true when currently loading", () => {
		expect(shouldSkipCatalogLoad({ isLoaded: false, isLoading: true })).toBe(
			true,
		);
	});

	test("false on initial state", () => {
		expect(shouldSkipCatalogLoad({ isLoaded: false, isLoading: false })).toBe(
			false,
		);
	});
});

describe("shouldSkipTagsFetch", () => {
	test("false when there is no existing entry", () => {
		expect(shouldSkipTagsFetch(undefined)).toBe(false);
	});

	test("false when the cached entry holds no tags", () => {
		expect(
			shouldSkipTagsFetch({ isLoading: false, error: null, tags: [] }),
		).toBe(false);
	});

	test("false when the cached entry has tags but ended in error", () => {
		expect(
			shouldSkipTagsFetch({
				isLoading: false,
				error: "boom",
				tags: [{ name: "latest" }],
			}),
		).toBe(false);
	});

	test("true when the cached entry holds tags and has no error", () => {
		expect(
			shouldSkipTagsFetch({
				isLoading: false,
				error: null,
				tags: [{ name: "latest" }],
			}),
		).toBe(true);
	});
});

describe("hitCacheKey", () => {
	test("strips the tag so every tag of a model shares one base-slug key", () => {
		expect(hitCacheKey("GPT-OSS:20b")).toBe("gpt-oss");
		expect(hitCacheKey("gpt-oss:120b")).toBe("gpt-oss");
	});

	test("passes through a bare slug (no colon) trimmed + lowercased", () => {
		expect(hitCacheKey("  Qwen3  ")).toBe("qwen3");
	});
});

describe("shouldSkipHitFetch", () => {
	test("false when there is no existing entry", () => {
		expect(shouldSkipHitFetch(undefined)).toBe(false);
	});

	test("false when a prior attempt errored (allows retry)", () => {
		expect(
			shouldSkipHitFetch({ isLoading: false, error: "boom", hit: null }),
		).toBe(false);
	});

	test("true when a non-error hit is already cached", () => {
		expect(
			shouldSkipHitFetch({
				isLoading: false,
				error: null,
				hit: { name: "gpt-oss" },
			}),
		).toBe(true);
	});
});

describe("useOllamaLibraryStore.fetchHit", () => {
	test("stores the scraped hit under the base-slug key", async () => {
		hitState.value = {
			name: "gpt-oss",
			description: "OpenAI open-weight models",
			capabilities: ["tools", "thinking"],
		};
		await useOllamaLibraryStore.getState().fetchHit("gpt-oss:20b");
		const entry = useOllamaLibraryStore.getState().hitsByModel["gpt-oss"];
		expect(entry?.isLoading).toBe(false);
		expect(entry?.hit?.description).toBe("OpenAI open-weight models");
		expect(entry?.hit?.capabilities).toEqual(["tools", "thinking"]);
		expect(callCounts.hit).toBe(1);
	});

	test("dedupes across tags of the same model (one scrape per base slug)", async () => {
		hitState.value = { name: "gpt-oss", description: "d" };
		await useOllamaLibraryStore.getState().fetchHit("gpt-oss:20b");
		await useOllamaLibraryStore.getState().fetchHit("gpt-oss:120b");
		expect(callCounts.hit).toBe(1);
	});

	test("ignores empty / whitespace-only input", async () => {
		await useOllamaLibraryStore.getState().fetchHit("   ");
		expect(callCounts.hit).toBe(0);
		expect(useOllamaLibraryStore.getState().hitsByModel).toEqual({});
	});
});

describe("useOllamaLibraryStore.loadCatalog", () => {
	test("loads catalog, marks isLoaded true, clears error", async () => {
		catalogState.value = {
			hits: [{ name: "llama3", description: "d", pulls: "1" }],
		};
		await useOllamaLibraryStore.getState().loadCatalog();
		const state = useOllamaLibraryStore.getState();
		expect(state.isLoaded).toBe(true);
		expect(state.isLoading).toBe(false);
		expect(state.catalog).toHaveLength(1);
		expect(state.error).toBeNull();
		expect(callCounts.catalog).toBe(1);
	});

	test("forwards the IPC-reported error into store.error", async () => {
		catalogState.value = { hits: [], error: "scrape failed" };
		await useOllamaLibraryStore.getState().loadCatalog();
		expect(useOllamaLibraryStore.getState().error).toBe("scrape failed");
		expect(useOllamaLibraryStore.getState().isLoaded).toBe(true);
	});

	test("collapses overlapping calls into a single fetch (multi-mount guard)", async () => {
		const { loadCatalog } = useOllamaLibraryStore.getState();
		await Promise.all([loadCatalog(), loadCatalog(), loadCatalog()]);
		expect(callCounts.catalog).toBe(1);
	});

	test("skips re-fetching once isLoaded is true", async () => {
		await useOllamaLibraryStore.getState().loadCatalog();
		expect(callCounts.catalog).toBe(1);
		await useOllamaLibraryStore.getState().loadCatalog();
		expect(callCounts.catalog).toBe(1);
	});
});

describe("useOllamaLibraryStore.fetchTags", () => {
	test("ignores empty / whitespace-only model names", async () => {
		await useOllamaLibraryStore.getState().fetchTags("   ");
		expect(callCounts.tags).toBe(0);
		expect(useOllamaLibraryStore.getState().tagsByModel).toEqual({});
	});

	test("stores fetched tags under the lowercase trimmed key", async () => {
		tagsState.value = {
			model: "",
			tags: [
				{
					name: "latest",
					sizeBytes: 100,
					parameterSize: "8B",
					quantization: "q4",
				},
			],
		};
		await useOllamaLibraryStore.getState().fetchTags(" Llama3 ");
		const entry = useOllamaLibraryStore.getState().tagsByModel["llama3"];
		expect(entry).toBeDefined();
		expect(entry?.isLoading).toBe(false);
		expect(entry?.error).toBeNull();
		expect(entry?.tags).toHaveLength(1);
		expect(callCounts.tags).toBe(1);
	});

	test("returns cached tags on second call (no re-fetch when error is null and tags present)", async () => {
		tagsState.value = {
			model: "",
			tags: [{ name: "latest" }],
		};
		await useOllamaLibraryStore.getState().fetchTags("phi");
		expect(callCounts.tags).toBe(1);
		await useOllamaLibraryStore.getState().fetchTags("phi");
		expect(callCounts.tags).toBe(1);
	});

	test("re-fetches when previous attempt errored even if tags array is stale-empty", async () => {
		tagsState.value = { model: "", tags: [], error: "first failure" };
		await useOllamaLibraryStore.getState().fetchTags("gemma");
		expect(callCounts.tags).toBe(1);
		// The prior entry has error="first failure" and empty tags so shouldSkipTagsFetch=false.
		tagsState.value = {
			model: "",
			tags: [{ name: "latest" }],
		};
		await useOllamaLibraryStore.getState().fetchTags("gemma");
		expect(callCounts.tags).toBe(2);
		expect(
			useOllamaLibraryStore.getState().tagsByModel["gemma"]?.error,
		).toBeNull();
	});

	test("marks the entry isLoading=true and preserves prior tags while in-flight", async () => {
		// Seed an existing entry with prior tags + error so the optimistic update path
		// keeps the existing tags visible during reload.
		useOllamaLibraryStore.setState({
			tagsByModel: {
				phi: {
					isLoading: false,
					error: "stale",
					tags: [{ name: "old" }],
				},
			},
		});
		const promise = useOllamaLibraryStore.getState().fetchTags("phi");
		// Synchronously after the call returns control to the microtask queue,
		// the pending entry should be in place with the old tags preserved.
		const mid = useOllamaLibraryStore.getState().tagsByModel["phi"];
		expect(mid?.isLoading).toBe(true);
		expect(mid?.error).toBeNull();
		expect(mid?.tags).toHaveLength(1);
		expect(mid?.tags[0]?.name).toBe("old");
		await promise;
	});

	test("propagates IPC error onto the cached entry", async () => {
		tagsState.value = { model: "", tags: [], error: "ollama down" };
		await useOllamaLibraryStore.getState().fetchTags("mistral");
		const entry = useOllamaLibraryStore.getState().tagsByModel["mistral"];
		expect(entry?.error).toBe("ollama down");
		expect(entry?.tags).toEqual([]);
	});
});
