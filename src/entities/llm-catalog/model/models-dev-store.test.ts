import { beforeEach, describe, expect, test } from "bun:test";

const SAMPLE = {
	moonshotai: {
		id: "moonshotai",
		name: "Moonshot AI",
		models: {
			"kimi-k2": {
				id: "kimi-k2",
				name: "Kimi K2",
				knowledge: "2024-12",
				release_date: "2025-09-05",
			},
		},
	},
};

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 500,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("condition not met in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("useModelsDevStore", () => {
	beforeEach(() => {
		globalThis.localStorage?.clear();
	});

	test("ensureLoaded fetches, indexes and caches models.dev, then lookup resolves", async () => {
		let fetches = 0;
		globalThis.fetch = (async () => {
			fetches += 1;
			return Response.json(SAMPLE);
		}) as typeof fetch;

		// Import AFTER stubbing fetch — the store fetches lazily via ensureLoaded,
		// so the module-load cache read (empty) is harmless.
		const { useModelsDevStore } = await import("./models-dev-store");
		const store = useModelsDevStore.getState();

		store.ensureLoaded();
		await waitFor(() => useModelsDevStore.getState().index !== null);

		const entry = useModelsDevStore
			.getState()
			.lookup("moonshotai/kimi-k2-0905", "Kimi K2");
		expect(entry?.developer).toBe("Moonshot AI");
		expect(entry?.knowledge).toBe("2024-12");
		expect(fetches).toBeGreaterThanOrEqual(1);

		// The parsed index is persisted for next time.
		expect(
			globalThis.localStorage.getItem("winstt:models-dev-index:v1"),
		).not.toBeNull();

		// ensureLoaded is idempotent — a second call does not refetch.
		const before = fetches;
		store.ensureLoaded();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetches).toBe(before);
	});
});
