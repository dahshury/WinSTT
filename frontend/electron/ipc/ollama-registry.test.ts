import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { debugLogMock } from "@test/mocks/debug-log";
import { electronMock } from "@test/mocks/electron";

const noop = () => undefined;

// Use the complete `electronMock()` factory so the process-global mock leak
// this installs is semantically complete — partial shims would make every
// later test importing `app` / `BrowserWindow` / etc. from `electron` throw
// "Export named X not found".
mock.module("electron", () => electronMock());
mock.module("../lib/debug-log", () => debugLogMock());

const { __ollama_registry_test_helpers__, setupOllamaRegistry } = await import("./ollama-registry");

const {
	parseSearchPage,
	parseTagsPage,
	parseSize,
	parseQuantization,
	parseParameterSize,
	assertSearchPayload,
	assertTagsPayload,
	searchOllamaLibrary,
	fetchOllamaLibraryCatalog,
	fetchOllamaLibraryTags,
	resetCachesForTests,
} = __ollama_registry_test_helpers__;

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(impl: (input: RequestInfo | URL) => Promise<Response>): void {
	globalThis.fetch = impl as typeof fetch;
}

function htmlResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

function errorResponse(status: number): Response {
	return new Response("oops", { status });
}

describe("parseSize", () => {
	it("parses GB labels into bytes", () => {
		const result = parseSize("3.3GB");
		expect(result?.bytes).toBe(3_300_000_000);
		expect(result?.label).toBe("3.3GB");
	});

	it("parses MB labels into bytes", () => {
		const result = parseSize("• 292MB • 32K context window");
		expect(result?.bytes).toBe(292_000_000);
	});

	it("returns null for unrecognised input", () => {
		expect(parseSize("no size here")).toBeNull();
	});
});

describe("parseQuantization", () => {
	it("extracts q4_K_M from a tag suffix", () => {
		expect(parseQuantization("gemma3:4b-it-q4_K_M")).toBe("Q4_K_M");
	});

	it("extracts q8_0 from a tag suffix", () => {
		expect(parseQuantization("gemma3:270m-it-q8_0")).toBe("Q8_0");
	});

	it("extracts fp16", () => {
		expect(parseQuantization("llama3.2:3b-fp16")).toBe("FP16");
	});

	it("returns undefined when no quantization marker present", () => {
		expect(parseQuantization("gemma3:4b")).toBeUndefined();
	});

	it("returns undefined for a tag with no suffix segment", () => {
		expect(parseQuantization("gemma3:")).toBeUndefined();
	});
});

describe("parseParameterSize", () => {
	it("extracts 4b from a base tag", () => {
		expect(parseParameterSize("gemma3:4b")).toBe("4B");
	});

	it("extracts 1.7b from a fractional tag", () => {
		expect(parseParameterSize("qwen3:1.7b")).toBe("1.7B");
	});

	it("extracts 270m from a million-parameter tag", () => {
		expect(parseParameterSize("gemma3:270m")).toBe("270M");
	});

	it("returns undefined when there's no suffix segment", () => {
		expect(parseParameterSize("gemma3:")).toBeUndefined();
	});

	it("returns undefined for tags with no param marker", () => {
		expect(parseParameterSize("gemma3:foo")).toBeUndefined();
	});
});

describe("parseSearchPage", () => {
	it("extracts hits from a minimal search HTML fixture", () => {
		const html = `
			<a href="/library/gemma3" class="group w-full">
				<div class="flex flex-col mb-1" title="gemma3">
					<h2>gemma3</h2>
					<p class="max-w-lg text-neutral-700">Google Gemma 3</p>
					<span>1.2M Pulls</span>
					<span>Updated 2 weeks ago</span>
				</div>
			</a>
			<a href="/library/gemma3n" class="group w-full">
				<div class="flex flex-col mb-1" title="gemma3n">
					<h2>gemma3n</h2>
					<p class="max-w-lg text-neutral-700">Gemma multimodal</p>
				</div>
			</a>
		`;
		const hits = parseSearchPage(html);
		expect(hits).toHaveLength(2);
		expect(hits[0]?.name).toBe("gemma3");
		expect(hits[0]?.description).toBe("Google Gemma 3");
		expect(hits[0]?.pulls).toBe("1.2M");
		expect(hits[0]?.updated).toBe("2 weeks ago");
		expect(hits[1]?.name).toBe("gemma3n");
	});

	it("skips tag-style links (slug containing colon)", () => {
		const html = `
			<a href="/library/gemma3:4b" class="group w-full">
				<div class="flex flex-col mb-1" title="gemma3:4b"></div>
			</a>
		`;
		expect(parseSearchPage(html)).toHaveLength(0);
	});

	it("captures capability spans alongside metadata", () => {
		const html = `
			<a href="/library/llava" class="group w-full">
				<div title="llava">
					<p class="max-w-lg">Multimodal</p>
					<span class="capability">vision</span>
					<span class="capability">tools</span>
				</div>
			</a>
		`;
		const [hit] = parseSearchPage(html);
		expect(hit?.capabilities).toEqual(["vision", "tools"]);
	});
});

describe("parseTagsPage", () => {
	it("extracts tags with sizes and quantization markers", () => {
		const html = `
			<a href="/library/gemma3:4b" class="md:hidden flex flex-col">
				<span class="group-hover:underline">gemma3:4b</span>
				<span class="text-blue-600">latest</span>
				• 3.3GB • 128K context window
			</a>
			<a href="/library/gemma3:4b-it-q8_0" class="md:hidden flex flex-col">
				<span>gemma3:4b-it-q8_0</span>
				• 4.5GB • 128K context window
			</a>
		`;
		const tags = parseTagsPage("gemma3", html);
		expect(tags).toHaveLength(2);
		// `latest` hoisted to top
		expect(tags[0]?.name).toBe("gemma3:4b");
		expect(tags[0]?.isLatest).toBe(true);
		expect(tags[0]?.sizeBytes).toBe(3_300_000_000);
		expect(tags[0]?.parameterSize).toBe("4B");
		expect(tags[0]?.contextWindow).toBe("128K");
		expect(tags[1]?.name).toBe("gemma3:4b-it-q8_0");
		expect(tags[1]?.quantization).toBe("Q8_0");
	});

	it("deduplicates the mobile + desktop renderings of the same tag", () => {
		const html = `
			<a href="/library/gemma3:4b" class="md:hidden flex flex-col">
				<span>gemma3:4b</span> • 3.3GB
			</a>
			<a href="/library/gemma3:4b" class="md:hidden flex flex-col">
				<span>gemma3:4b</span> • 3.3GB
			</a>
		`;
		expect(parseTagsPage("gemma3", html)).toHaveLength(1);
	});

	it("preserves scrape order when no `latest` row is present", () => {
		const html = `
			<a href="/library/foo:1" class="md:hidden flex flex-col"><span>foo:1</span></a>
			<a href="/library/foo:2" class="md:hidden flex flex-col"><span>foo:2</span></a>
		`;
		const tags = parseTagsPage("foo", html);
		expect(tags.map((t) => t.name)).toEqual(["foo:1", "foo:2"]);
	});
});

describe("assertSearchPayload", () => {
	it("accepts a payload with a string `query`", () => {
		expect(() => assertSearchPayload({ query: "hello" })).not.toThrow();
	});

	it("rejects non-object payloads", () => {
		expect(() => assertSearchPayload(null)).toThrow(/must be an object/);
		expect(() => assertSearchPayload("nope")).toThrow(/must be an object/);
	});

	it("rejects payloads missing the `query` field", () => {
		expect(() => assertSearchPayload({})).toThrow(/missing string `query`/);
	});
});

describe("assertTagsPayload", () => {
	it("accepts a payload with a string `model`", () => {
		expect(() => assertTagsPayload({ model: "gemma3" })).not.toThrow();
	});

	it("rejects non-object payloads", () => {
		expect(() => assertTagsPayload(undefined)).toThrow(/must be an object/);
	});

	it("rejects payloads missing the `model` field", () => {
		expect(() => assertTagsPayload({ query: "x" })).toThrow(/missing string `model`/);
	});
});

describe("searchOllamaLibrary", () => {
	beforeEach(() => {
		resetCachesForTests();
	});
	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		resetCachesForTests();
	});

	it("returns an empty result when the query is blank", async () => {
		const result = await searchOllamaLibrary("   ", 0);
		expect(result.hits).toEqual([]);
		expect(result.hasMore).toBe(false);
		expect(result.query).toBe("");
	});

	it("scrapes the search page and caches the result", async () => {
		let callCount = 0;
		mockFetch(async () => {
			callCount++;
			return htmlResponse(`
				<a href="/library/foo" class="group w-full">
					<div title="foo"><p class="max-w-lg">Foo desc</p></div>
				</a>
			`);
		});
		const first = await searchOllamaLibrary("foo", 0);
		const second = await searchOllamaLibrary("foo", 0);
		expect(first.hits).toHaveLength(1);
		expect(first.hits[0]?.name).toBe("foo");
		expect(second).toEqual(first);
		expect(callCount).toBe(1);
	});

	it("uses the paged search URL when page > 0", async () => {
		let receivedUrl = "";
		mockFetch(async (url) => {
			receivedUrl = url.toString();
			return htmlResponse("");
		});
		await searchOllamaLibrary("bar", 2);
		expect(receivedUrl).toContain("&p=2");
	});

	it("records a failure result when fetch throws", async () => {
		mockFetch(async () => {
			throw new Error("network down");
		});
		const result = await searchOllamaLibrary("baz", 0);
		expect(result.hits).toEqual([]);
		expect(result.error).toBe("network down");
	});

	it("records a failure result on HTTP error", async () => {
		mockFetch(async () => errorResponse(500));
		const result = await searchOllamaLibrary("qux", 0);
		expect(result.error).toContain("HTTP 500");
	});

	it("falls back to a generic error message for non-Error rejections", async () => {
		mockFetch(() => Promise.reject("string rejection"));
		const result = await searchOllamaLibrary("zap", 0);
		expect(result.error).toBe("Failed to reach ollama.com");
	});
});

describe("fetchOllamaLibraryCatalog", () => {
	beforeEach(() => {
		resetCachesForTests();
	});
	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		resetCachesForTests();
	});

	it("returns scraped hits and caches the catalog", async () => {
		let callCount = 0;
		mockFetch(async () => {
			callCount++;
			return htmlResponse(`
				<a href="/library/alpha" class="group w-full"><div title="alpha"></div></a>
			`);
		});
		const first = await fetchOllamaLibraryCatalog();
		const second = await fetchOllamaLibraryCatalog();
		expect(first.hits).toHaveLength(1);
		expect(second).toEqual(first);
		expect(callCount).toBe(1);
	});

	it("returns an error result when the fetch fails", async () => {
		mockFetch(async () => {
			throw new Error("offline");
		});
		const result = await fetchOllamaLibraryCatalog();
		expect(result.hits).toEqual([]);
		expect(result.error).toBe("offline");
	});
});

describe("fetchOllamaLibraryTags", () => {
	beforeEach(() => {
		resetCachesForTests();
	});
	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		resetCachesForTests();
	});

	it("returns an empty result for a blank model", async () => {
		const result = await fetchOllamaLibraryTags("   ");
		expect(result.model).toBe("");
		expect(result.tags).toEqual([]);
	});

	it("scrapes tag listings and caches them", async () => {
		let callCount = 0;
		mockFetch(async () => {
			callCount++;
			return htmlResponse(`
				<a href="/library/foo:1" class="md:hidden flex flex-col"><span>foo:1</span></a>
			`);
		});
		const first = await fetchOllamaLibraryTags("foo");
		const second = await fetchOllamaLibraryTags("foo");
		expect(first.tags).toHaveLength(1);
		expect(second).toEqual(first);
		expect(callCount).toBe(1);
	});

	it("returns an error result when the fetch fails", async () => {
		mockFetch(async () => {
			throw new Error("dns failure");
		});
		const result = await fetchOllamaLibraryTags("foo");
		expect(result.error).toBe("dns failure");
	});
});

describe("setupOllamaRegistry", () => {
	it("returns a teardown function that does not throw", () => {
		const teardown = setupOllamaRegistry();
		expect(typeof teardown).toBe("function");
		expect(() => teardown()).not.toThrow();
	});
});
