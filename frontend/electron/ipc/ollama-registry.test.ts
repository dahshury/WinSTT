import { describe, expect, it, mock } from "bun:test";

const noop = () => undefined;

mock.module("electron", () => ({
	ipcMain: { handle: noop, removeHandler: noop },
}));
mock.module("../lib/debug-log", () => ({ dbg: noop, dbgVerbose: noop }));

const { __ollama_registry_test_helpers__ } = await import("./ollama-registry");

const { parseSearchPage, parseTagsPage, parseSize, parseQuantization, parseParameterSize } =
	__ollama_registry_test_helpers__;

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
});
