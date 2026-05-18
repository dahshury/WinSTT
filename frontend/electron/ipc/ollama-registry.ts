/**
 * Ollama registry scraper.
 *
 * Ollama doesn't publish a JSON search API for its public library, so we
 * scrape the HTML pages at:
 *   - https://ollama.com/search?q=<query>&p=<page>
 *   - https://ollama.com/library/<model>/tags
 *
 * Both pages are server-rendered HTML with a stable enough structure that a
 * handful of regex extractors do the job without pulling in cheerio. Results
 * are cached in-process with a short TTL so opening/closing the picker
 * repeatedly doesn't hammer Ollama's CDN.
 */

import { ipcMain } from "electron";
import { IPC } from "../../src/shared/api/ipc-channels";
import type {
	OllamaLibraryCatalogResult,
	OllamaLibraryHit,
	OllamaLibrarySearchResult,
	OllamaLibraryTag,
	OllamaLibraryTagsResult,
} from "../../src/shared/api/models";
import { dbg } from "../lib/debug-log";

const OLLAMA_BASE = "https://ollama.com";
const USER_AGENT = "WinSTT/1.0 (+https://github.com/dahshury/WinSTT)";
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Full library catalog rarely changes — hold it for an hour so reopening the
// picker doesn't re-scrape every time. Per-tag pages keep the shorter TTL.
const CATALOG_TTL_MS = 60 * 60 * 1000;
const PAGE_SIZE = 20;

interface CacheEntry<T> {
	expiresAt: number;
	value: T;
}

const searchCache = new Map<string, CacheEntry<OllamaLibrarySearchResult>>();
const tagsCache = new Map<string, CacheEntry<OllamaLibraryTagsResult>>();
let catalogCache: CacheEntry<OllamaLibraryCatalogResult> | null = null;

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
	const hit = map.get(key);
	if (!hit) {
		return null;
	}
	if (hit.expiresAt < Date.now()) {
		map.delete(key);
		return null;
	}
	return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
	map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchHtml(url: string): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`Ollama returned HTTP ${res.status}`);
		}
		return await res.text();
	} finally {
		clearTimeout(timer);
	}
}

// ── Search-page parser ────────────────────────────────────────────────

const SEARCH_HIT_RE = /<a\s+href="\/library\/([^"]+)"\s+class="group w-full">/g;
const TITLE_ATTR_RE = /title="([^"]+)"/;
const DESCRIPTION_RE = /<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>([\s\S]*?)<\/p>/;
const PULLS_RE = /<span[^>]*>([\d.,]+[KMB]?)\s*Pulls?<\/span>/i;
const UPDATED_RE = /<span[^>]*>Updated\s+([^<]+)<\/span>/i;
const CAPABILITY_RE = /<span[^>]*class="[^"]*capability[^"]*"[^>]*>([^<]+)<\/span>/g;

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
}

function parseCapabilities(block: string): string[] | undefined {
	const capabilities: string[] = [];
	for (const capMatch of block.matchAll(CAPABILITY_RE)) {
		const cap = stripTags(capMatch[1] ?? "");
		if (cap) {
			capabilities.push(cap);
		}
	}
	return capabilities.length > 0 ? capabilities : undefined;
}

function parseSearchHit(block: string, slug: string): OllamaLibraryHit {
	const titleMatch = block.match(TITLE_ATTR_RE);
	const descMatch = block.match(DESCRIPTION_RE);
	const pullsMatch = block.match(PULLS_RE);
	const updatedMatch = block.match(UPDATED_RE);
	return {
		name: titleMatch?.[1] ?? slug,
		description: descMatch ? stripTags(descMatch[1] ?? "") : undefined,
		pulls: pullsMatch ? stripTags(pullsMatch[1] ?? "") : undefined,
		updated: updatedMatch ? stripTags(updatedMatch[1] ?? "") : undefined,
		capabilities: parseCapabilities(block),
	};
}

function parseSearchPage(html: string): OllamaLibraryHit[] {
	const hits: OllamaLibraryHit[] = [];
	const anchors = [...html.matchAll(SEARCH_HIT_RE)];
	for (let i = 0; i < anchors.length; i++) {
		const match = anchors[i];
		if (!match) {
			continue;
		}
		const slug = match[1] ?? "";
		if (!slug || slug.includes(":") || slug.includes("/")) {
			continue;
		}
		const start = match.index ?? 0;
		const end = anchors[i + 1]?.index ?? html.length;
		const block = html.slice(start, end);
		hits.push(parseSearchHit(block, slug));
	}
	return hits;
}

// ── Tag-page parser ───────────────────────────────────────────────────

const SIZE_UNITS: Record<string, number> = {
	KB: 1000,
	MB: 1_000_000,
	GB: 1_000_000_000,
	TB: 1_000_000_000_000,
};

const TAG_ANCHOR_RE = /<a\s+href="\/library\/([^"]+:[^"]+)"\s+class="md:hidden[^"]*"[^>]*>/g;
const SIZE_RE = /([\d.]+)\s*(KB|MB|GB|TB)/i;
const CONTEXT_RE = /([\d.]+[KMB])\s*context\s*window/i;
const QUANT_TOKEN_RE = /(?:^|[-:_])(q\d[a-z0-9_]*|fp\d+|int\d+|bf\d+)(?=$|[-:_])/i;
const PARAM_TOKEN_RE = /(?:^|[-:_])(\d+(?:\.\d+)?[mMbB])(?=$|[-:_])/;
const LATEST_TAG_RE = /text-blue-600[^>]*>latest</i;

function parseSize(raw: string): { bytes: number; label: string } | null {
	const match = raw.match(SIZE_RE);
	if (!match) {
		return null;
	}
	const value = Number.parseFloat(match[1] ?? "0");
	const unit = (match[2] ?? "").toUpperCase();
	const multiplier = SIZE_UNITS[unit] ?? 1;
	if (!Number.isFinite(value) || multiplier === 0) {
		return null;
	}
	return { bytes: Math.round(value * multiplier), label: `${match[1]}${unit}` };
}

function parseQuantization(tag: string): string | undefined {
	const segment = tag.includes(":") ? tag.split(":")[1] : tag;
	if (!segment) {
		return;
	}
	const match = segment.match(QUANT_TOKEN_RE);
	if (!match) {
		return;
	}
	return match[1]?.toUpperCase();
}

function parseParameterSize(tag: string): string | undefined {
	const segment = tag.includes(":") ? tag.split(":")[1] : tag;
	if (!segment) {
		return;
	}
	const match = segment.match(PARAM_TOKEN_RE);
	if (!match) {
		return;
	}
	return match[1]?.toUpperCase();
}

function parseTagsPage(_model: string, html: string): OllamaLibraryTag[] {
	const tags: OllamaLibraryTag[] = [];
	const seen = new Set<string>();
	// Each tag block starts at the matching anchor; we grab the surrounding
	// text up to the next anchor or end of file to scan for size / context.
	const anchors = [...html.matchAll(TAG_ANCHOR_RE)];
	for (let i = 0; i < anchors.length; i++) {
		const match = anchors[i];
		if (!match) {
			continue;
		}
		const name = match[1] ?? "";
		if (!name || seen.has(name)) {
			continue;
		}
		seen.add(name);
		const start = match.index ?? 0;
		const end = anchors[i + 1]?.index ?? html.length;
		const block = html.slice(start, end);
		const sizeInfo = parseSize(block);
		const ctxMatch = block.match(CONTEXT_RE);
		const isLatest = LATEST_TAG_RE.test(block);
		tags.push({
			name,
			sizeBytes: sizeInfo?.bytes,
			sizeLabel: sizeInfo?.label,
			contextWindow: ctxMatch ? ctxMatch[1] : undefined,
			quantization: parseQuantization(name),
			parameterSize: parseParameterSize(name),
			isLatest: isLatest || undefined,
		});
	}
	// Ollama's tag page renders each row twice (mobile + desktop). We dedup
	// by tag name above, but the page also starts with a `:latest` alias
	// pointing at a canonical tag. If `<model>:latest` was seen, surface it
	// first; otherwise preserve scrape order.
	tags.sort((a, b) => {
		if (a.isLatest && !b.isLatest) {
			return -1;
		}
		if (!a.isLatest && b.isLatest) {
			return 1;
		}
		return 0;
	});
	return tags;
}

// ── Public scrape entry points ────────────────────────────────────────

export async function searchOllamaLibrary(
	query: string,
	page = 0
): Promise<OllamaLibrarySearchResult> {
	const trimmed = query.trim();
	if (!trimmed) {
		return { hits: [], hasMore: false, page, query: trimmed };
	}
	const cacheKey = `${trimmed.toLowerCase()}::${page}`;
	const cached = cacheGet(searchCache, cacheKey);
	if (cached) {
		return cached;
	}
	const url = `${OLLAMA_BASE}/search?q=${encodeURIComponent(trimmed)}${page > 0 ? `&p=${page}` : ""}`;
	try {
		const html = await fetchHtml(url);
		const allHits = parseSearchPage(html);
		// Ollama's search returns the full result set on one HTML page; we
		// paginate client-side to keep the UI responsive on large queries.
		const sliceStart = page * PAGE_SIZE;
		const hits = allHits.slice(sliceStart, sliceStart + PAGE_SIZE);
		const result: OllamaLibrarySearchResult = {
			hits,
			hasMore: sliceStart + PAGE_SIZE < allHits.length,
			page,
			query: trimmed,
		};
		cacheSet(searchCache, cacheKey, result);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to reach ollama.com";
		dbg("ollama-registry: search failed", { query: trimmed, page, error: message });
		return { hits: [], hasMore: false, page, query: trimmed, error: message };
	}
}

/**
 * Fetch the full Ollama library in one shot from `ollama.com/library`.
 * The page lists every published model family (currently ~230), so we parse
 * the entire result once and hand it to the renderer for client-side
 * filtering. Cached for {@link CATALOG_TTL_MS} since the library only grows.
 */
export async function fetchOllamaLibraryCatalog(): Promise<OllamaLibraryCatalogResult> {
	if (catalogCache && catalogCache.expiresAt >= Date.now()) {
		return catalogCache.value;
	}
	const url = `${OLLAMA_BASE}/library`;
	try {
		const html = await fetchHtml(url);
		const hits = parseSearchPage(html);
		const result: OllamaLibraryCatalogResult = { hits };
		catalogCache = { value: result, expiresAt: Date.now() + CATALOG_TTL_MS };
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to reach ollama.com";
		dbg("ollama-registry: catalog fetch failed", { error: message });
		return { hits: [], error: message };
	}
}

export async function fetchOllamaLibraryTags(model: string): Promise<OllamaLibraryTagsResult> {
	const trimmed = model.trim();
	if (!trimmed) {
		return { model: trimmed, tags: [] };
	}
	const cacheKey = trimmed.toLowerCase();
	const cached = cacheGet(tagsCache, cacheKey);
	if (cached) {
		return cached;
	}
	const url = `${OLLAMA_BASE}/library/${encodeURIComponent(trimmed)}/tags`;
	try {
		const html = await fetchHtml(url);
		const tags = parseTagsPage(trimmed, html);
		const result: OllamaLibraryTagsResult = { model: trimmed, tags };
		cacheSet(tagsCache, cacheKey, result);
		return result;
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to reach ollama.com";
		dbg("ollama-registry: tags fetch failed", { model: trimmed, error: message });
		return { model: trimmed, tags: [], error: message };
	}
}

// ── IPC wiring ────────────────────────────────────────────────────────

interface SearchPayload {
	page?: number;
	query: string;
}

interface TagsPayload {
	model: string;
}

function assertSearchPayload(payload: unknown): asserts payload is SearchPayload {
	if (!(payload && typeof payload === "object")) {
		throw new Error("search payload must be an object");
	}
	const candidate = payload as Record<string, unknown>;
	if (typeof candidate.query !== "string") {
		throw new Error("search payload missing string `query`");
	}
}

function assertTagsPayload(payload: unknown): asserts payload is TagsPayload {
	if (!(payload && typeof payload === "object")) {
		throw new Error("tags payload must be an object");
	}
	const candidate = payload as Record<string, unknown>;
	if (typeof candidate.model !== "string") {
		throw new Error("tags payload missing string `model`");
	}
}

export function setupOllamaRegistry(): () => void {
	const handleSearch = async (_event: unknown, payload: unknown) => {
		assertSearchPayload(payload);
		return await searchOllamaLibrary(payload.query, payload.page ?? 0);
	};

	const handleCatalog = async () => fetchOllamaLibraryCatalog();

	const handleTags = async (_event: unknown, payload: unknown) => {
		assertTagsPayload(payload);
		return await fetchOllamaLibraryTags(payload.model);
	};

	ipcMain.handle(IPC.LLM_SEARCH_OLLAMA_LIBRARY, handleSearch);
	ipcMain.handle(IPC.LLM_FETCH_OLLAMA_LIBRARY, handleCatalog);
	ipcMain.handle(IPC.LLM_FETCH_OLLAMA_TAGS, handleTags);

	return () => {
		ipcMain.removeHandler(IPC.LLM_SEARCH_OLLAMA_LIBRARY);
		ipcMain.removeHandler(IPC.LLM_FETCH_OLLAMA_LIBRARY);
		ipcMain.removeHandler(IPC.LLM_FETCH_OLLAMA_TAGS);
		searchCache.clear();
		tagsCache.clear();
		catalogCache = null;
	};
}

// Test-only exports for the parser internals — pure functions, no IPC.
export const __ollama_registry_test_helpers__ = {
	parseSearchPage,
	parseTagsPage,
	parseSize,
	parseQuantization,
	parseParameterSize,
};
