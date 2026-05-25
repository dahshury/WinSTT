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

// ── Cache helpers ─────────────────────────────────────────────────────

function isExpired<T>(entry: CacheEntry<T>): boolean {
	return entry.expiresAt < Date.now();
}

function dropAndReturnNull<T>(map: Map<string, CacheEntry<T>>, key: string): null {
	map.delete(key);
	return null;
}

function unwrapEntry<T>(
	map: Map<string, CacheEntry<T>>,
	key: string,
	entry: CacheEntry<T>
): T | null {
	return isExpired(entry) ? dropAndReturnNull(map, key) : entry.value;
}

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
	const hit = map.get(key);
	return hit ? unwrapEntry(map, key, hit) : null;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
	map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ── HTTP fetcher ──────────────────────────────────────────────────────

function abortAfter(controller: AbortController, ms: number): ReturnType<typeof setTimeout> {
	return setTimeout(() => controller.abort(), ms);
}

async function readOk(res: Response): Promise<string> {
	return res.ok ? await res.text() : throwHttpError(res.status);
}

function throwHttpError(status: number): never {
	throw new Error(`Ollama returned HTTP ${status}`);
}

async function fetchHtml(url: string): Promise<string> {
	const controller = new AbortController();
	const timer = abortAfter(controller, REQUEST_TIMEOUT_MS);
	const fetched = fetch(url, {
		headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
		signal: controller.signal,
	}).then(readOk);
	return await fetched.finally(() => clearTimeout(timer));
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

function capabilityFromMatch(match: RegExpMatchArray): string {
	return stripTags(match[1] ?? "");
}

function isNonEmpty(s: string): boolean {
	return s.length > 0;
}

function nonEmptyOrUndefined<T>(arr: T[]): T[] | undefined {
	return arr.length > 0 ? arr : undefined;
}

function parseCapabilities(block: string): string[] | undefined {
	const matches = [...block.matchAll(CAPABILITY_RE)];
	const caps = matches.map(capabilityFromMatch).filter(isNonEmpty);
	return nonEmptyOrUndefined(caps);
}

function firstGroup(match: RegExpMatchArray | null): string | undefined {
	return match ? stripTags(match[1] ?? "") : undefined;
}

function nameFromTitle(match: RegExpMatchArray | null, slug: string): string {
	return match?.[1] ?? slug;
}

function assignDefined<T>(target: T, source: Record<string, unknown>): T {
	for (const [key, value] of Object.entries(source)) {
		applyIfDefined(target as Record<string, unknown>, key, value);
	}
	return target;
}

function applyIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
	const apply = applierFor(value);
	apply(target, key, value);
}

function applierFor(
	value: unknown
): (target: Record<string, unknown>, key: string, value: unknown) => void {
	return value === undefined ? noopApply : setProp;
}

function setProp(target: Record<string, unknown>, key: string, value: unknown): void {
	target[key] = value;
}

function noopApply(_target: Record<string, unknown>, _key: string, _value: unknown): void {
	return;
}

function parseSearchHit(block: string, slug: string): OllamaLibraryHit {
	const titleMatch = block.match(TITLE_ATTR_RE);
	const descMatch = block.match(DESCRIPTION_RE);
	const pullsMatch = block.match(PULLS_RE);
	const updatedMatch = block.match(UPDATED_RE);
	const base: OllamaLibraryHit = { name: nameFromTitle(titleMatch, slug) };
	const extras: Record<string, unknown> = {
		description: firstGroup(descMatch),
		pulls: firstGroup(pullsMatch),
		updated: firstGroup(updatedMatch),
		capabilities: parseCapabilities(block),
	};
	return assignDefined(base, extras);
}

function isValidSlug(slug: string): boolean {
	return slug.length > 0 && !(slug.includes(":") || slug.includes("/"));
}

function slugFrom(match: RegExpMatchArray): string {
	return match[1] ?? "";
}

function startIndex(match: RegExpMatchArray): number {
	return match.index ?? 0;
}

function endIndexFrom(next: RegExpMatchArray | undefined, fallback: number): number {
	return next ? startIndex(next) : fallback;
}

interface AnchorSpan {
	end: number;
	match: RegExpMatchArray;
	slug: string;
	start: number;
}

function spanFor(
	match: RegExpMatchArray,
	next: RegExpMatchArray | undefined,
	end: number
): AnchorSpan {
	return { match, slug: slugFrom(match), start: startIndex(match), end: endIndexFrom(next, end) };
}

function isValidSpan(span: AnchorSpan): boolean {
	return isValidSlug(span.slug);
}

function spansFromAnchors(anchors: RegExpMatchArray[], htmlLength: number): AnchorSpan[] {
	return anchors.map((match, i) => spanFor(match, anchors[i + 1], htmlLength));
}

function hitFromSpan(html: string): (span: AnchorSpan) => OllamaLibraryHit {
	return (span) => parseSearchHit(html.slice(span.start, span.end), span.slug);
}

function parseSearchPage(html: string): OllamaLibraryHit[] {
	const anchors = [...html.matchAll(SEARCH_HIT_RE)];
	const spans = spansFromAnchors(anchors, html.length).filter(isValidSpan);
	return spans.map(hitFromSpan(html));
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

interface SizeInfo {
	bytes: number;
	label: string;
}

function parseValue(match: RegExpMatchArray): number {
	return Number.parseFloat(match[1] ?? "0");
}

function parseUnit(match: RegExpMatchArray): string {
	return (match[2] ?? "").toUpperCase();
}

function multiplierFor(unit: string): number {
	return SIZE_UNITS[unit] ?? 1;
}

function sizeInfoFor(match: RegExpMatchArray): SizeInfo | null {
	const value = parseValue(match);
	const unit = parseUnit(match);
	const multiplier = multiplierFor(unit);
	return finalizeSize(value, multiplier, match[1] ?? "", unit);
}

function isValidSizeBase(value: number, multiplier: number): boolean {
	return Number.isFinite(value) && multiplier > 0;
}

function finalizeSize(
	value: number,
	multiplier: number,
	rawValue: string,
	unit: string
): SizeInfo | null {
	return isValidSizeBase(value, multiplier)
		? { bytes: Math.round(value * multiplier), label: `${rawValue}${unit}` }
		: null;
}

function parseSize(raw: string): SizeInfo | null {
	const match = raw.match(SIZE_RE);
	return match ? sizeInfoFor(match) : null;
}

function suffixSegment(tag: string): string {
	return tag.includes(":") ? (tag.split(":")[1] ?? "") : tag;
}

function upperCaseGroup1(match: RegExpMatchArray | null): string | undefined {
	return match?.[1]?.toUpperCase();
}

function parseQuantization(tag: string): string | undefined {
	const segment = suffixSegment(tag);
	return upperCaseGroup1(segment.match(QUANT_TOKEN_RE));
}

function parseParameterSize(tag: string): string | undefined {
	const segment = suffixSegment(tag);
	return upperCaseGroup1(segment.match(PARAM_TOKEN_RE));
}

function contextWindowFrom(block: string): string | undefined {
	const match = block.match(CONTEXT_RE);
	return match?.[1];
}

function isLatest(block: string): true | undefined {
	return LATEST_TAG_RE.test(block) ? true : undefined;
}

function bytesFrom(sizeInfo: SizeInfo | null): number | undefined {
	return sizeInfo?.bytes;
}

function labelFrom(sizeInfo: SizeInfo | null): string | undefined {
	return sizeInfo?.label;
}

function buildLibraryTag(name: string, block: string): OllamaLibraryTag {
	const sizeInfo = parseSize(block);
	const extras: Record<string, unknown> = {
		sizeBytes: bytesFrom(sizeInfo),
		sizeLabel: labelFrom(sizeInfo),
		contextWindow: contextWindowFrom(block),
		quantization: parseQuantization(name),
		parameterSize: parseParameterSize(name),
		isLatest: isLatest(block),
	};
	return assignDefined({ name } as OllamaLibraryTag, extras);
}

interface TagSpan {
	end: number;
	name: string;
	start: number;
}

function tagSpanFor(
	match: RegExpMatchArray,
	next: RegExpMatchArray | undefined,
	end: number
): TagSpan {
	return { name: match[1] ?? "", start: startIndex(match), end: endIndexFrom(next, end) };
}

function tagSpansFromAnchors(anchors: RegExpMatchArray[], htmlLength: number): TagSpan[] {
	return anchors.map((match, i) => tagSpanFor(match, anchors[i + 1], htmlLength));
}

function dedupByName(spans: TagSpan[]): TagSpan[] {
	const seen = new Set<string>();
	return spans.filter((span) => acceptIfFirst(span, seen));
}

function acceptIfFirst(span: TagSpan, seen: Set<string>): boolean {
	const accept = span.name.length > 0 && !seen.has(span.name);
	return accept ? markAndAccept(span.name, seen) : false;
}

function markAndAccept(name: string, seen: Set<string>): true {
	seen.add(name);
	return true;
}

function tagFromSpan(html: string): (span: TagSpan) => OllamaLibraryTag {
	return (span) => buildLibraryTag(span.name, html.slice(span.start, span.end));
}

// Ollama's tag page renders each row twice (mobile + desktop). We dedup
// by tag name above, but the page also starts with a `:latest` alias
// pointing at a canonical tag. If `<model>:latest` was seen, surface it
// first; otherwise preserve scrape order.
function latestRank(tag: OllamaLibraryTag): number {
	return tag.isLatest ? 0 : 1;
}

function byLatestFirst(a: OllamaLibraryTag, b: OllamaLibraryTag): number {
	return latestRank(a) - latestRank(b);
}

function parseTagsPage(_model: string, html: string): OllamaLibraryTag[] {
	const anchors = [...html.matchAll(TAG_ANCHOR_RE)];
	const spans = dedupByName(tagSpansFromAnchors(anchors, html.length));
	const tags = spans.map(tagFromSpan(html));
	tags.sort(byLatestFirst);
	return tags;
}

// ── Public scrape entry points ────────────────────────────────────────

function emptySearchResult(page: number, query: string, error?: string): OllamaLibrarySearchResult {
	const base: OllamaLibrarySearchResult = { hits: [], hasMore: false, page, query };
	return assignDefined(base, { error });
}

function describeError(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

function searchUrlFor(query: string, page: number): string {
	const pageSuffix = page > 0 ? `&p=${page}` : "";
	return `${OLLAMA_BASE}/search?q=${encodeURIComponent(query)}${pageSuffix}`;
}

function sliceHits(allHits: OllamaLibraryHit[], page: number): OllamaLibrarySearchResult["hits"] {
	const start = page * PAGE_SIZE;
	return allHits.slice(start, start + PAGE_SIZE);
}

function hasMoreAfter(allHits: OllamaLibraryHit[], page: number): boolean {
	return (page + 1) * PAGE_SIZE < allHits.length;
}

async function scrapeSearch(
	query: string,
	page: number,
	cacheKey: string
): Promise<OllamaLibrarySearchResult> {
	const html = await fetchHtml(searchUrlFor(query, page));
	const allHits = parseSearchPage(html);
	const result: OllamaLibrarySearchResult = {
		hits: sliceHits(allHits, page),
		hasMore: hasMoreAfter(allHits, page),
		page,
		query,
	};
	cacheSet(searchCache, cacheKey, result);
	return result;
}

async function searchOrFail(
	query: string,
	page: number,
	cacheKey: string
): Promise<OllamaLibrarySearchResult> {
	return await scrapeSearch(query, page, cacheKey).catch((err: unknown) =>
		recordSearchFailure(query, page, err)
	);
}

function recordSearchFailure(query: string, page: number, err: unknown): OllamaLibrarySearchResult {
	const message = describeError(err, "Failed to reach ollama.com");
	dbg("ollama-registry: search failed", { query, page, error: message });
	return emptySearchResult(page, query, message);
}

function searchCacheKey(query: string, page: number): string {
	return `${query.toLowerCase()}::${page}`;
}

async function searchOrCached(trimmed: string, page: number): Promise<OllamaLibrarySearchResult> {
	const cacheKey = searchCacheKey(trimmed, page);
	const cached = cacheGet(searchCache, cacheKey);
	return cached ?? (await searchOrFail(trimmed, page, cacheKey));
}

async function searchOllamaLibrary(query: string, page = 0): Promise<OllamaLibrarySearchResult> {
	const trimmed = query.trim();
	return trimmed.length > 0
		? await searchOrCached(trimmed, page)
		: emptySearchResult(page, trimmed);
}

function emptyCatalogResult(error?: string): OllamaLibraryCatalogResult {
	return assignDefined({ hits: [] } as OllamaLibraryCatalogResult, { error });
}

async function scrapeCatalog(): Promise<OllamaLibraryCatalogResult> {
	const html = await fetchHtml(`${OLLAMA_BASE}/library`);
	const result: OllamaLibraryCatalogResult = { hits: parseSearchPage(html) };
	catalogCache = { value: result, expiresAt: Date.now() + CATALOG_TTL_MS };
	return result;
}

function recordCatalogFailure(err: unknown): OllamaLibraryCatalogResult {
	const message = describeError(err, "Failed to reach ollama.com");
	dbg("ollama-registry: catalog fetch failed", { error: message });
	return emptyCatalogResult(message);
}

async function catalogOrFail(): Promise<OllamaLibraryCatalogResult> {
	return await scrapeCatalog().catch(recordCatalogFailure);
}

function liveCatalogCache(): OllamaLibraryCatalogResult | null {
	return catalogCache && !isExpired(catalogCache) ? catalogCache.value : null;
}

/**
 * Fetch the full Ollama library in one shot from `ollama.com/library`.
 * The page lists every published model family (currently ~230), so we parse
 * the entire result once and hand it to the renderer for client-side
 * filtering. Cached for {@link CATALOG_TTL_MS} since the library only grows.
 */
async function fetchOllamaLibraryCatalog(): Promise<OllamaLibraryCatalogResult> {
	return liveCatalogCache() ?? (await catalogOrFail());
}

function emptyTagsResult(model: string, error?: string): OllamaLibraryTagsResult {
	const base: OllamaLibraryTagsResult = { model, tags: [] };
	return assignDefined(base, { error });
}

async function scrapeTags(model: string, cacheKey: string): Promise<OllamaLibraryTagsResult> {
	const html = await fetchHtml(`${OLLAMA_BASE}/library/${encodeURIComponent(model)}/tags`);
	const result: OllamaLibraryTagsResult = { model, tags: parseTagsPage(model, html) };
	cacheSet(tagsCache, cacheKey, result);
	return result;
}

function recordTagsFailure(model: string, err: unknown): OllamaLibraryTagsResult {
	const message = describeError(err, "Failed to reach ollama.com");
	dbg("ollama-registry: tags fetch failed", { model, error: message });
	return emptyTagsResult(model, message);
}

async function tagsOrFail(model: string, cacheKey: string): Promise<OllamaLibraryTagsResult> {
	return await scrapeTags(model, cacheKey).catch((err: unknown) => recordTagsFailure(model, err));
}

async function tagsOrCached(trimmed: string): Promise<OllamaLibraryTagsResult> {
	const cacheKey = trimmed.toLowerCase();
	const cached = cacheGet(tagsCache, cacheKey);
	return cached ?? (await tagsOrFail(trimmed, cacheKey));
}

async function fetchOllamaLibraryTags(model: string): Promise<OllamaLibraryTagsResult> {
	const trimmed = model.trim();
	return trimmed.length > 0 ? await tagsOrCached(trimmed) : emptyTagsResult(trimmed);
}

// ── IPC wiring ────────────────────────────────────────────────────────

interface SearchPayload {
	page?: number;
	query: string;
}

interface TagsPayload {
	model: string;
}

function isObjectRecord(payload: unknown): payload is Record<string, unknown> {
	return Boolean(payload) && typeof payload === "object";
}

function assertObject(payload: unknown, label: string): asserts payload is Record<string, unknown> {
	requireTrue(isObjectRecord(payload), `${label} payload must be an object`);
}

function requireTrue(condition: boolean, message: string): asserts condition {
	const enforce = condition ? noopAssert : throwAssert;
	enforce(message);
}

function noopAssert(_message: string): void {
	return;
}

function throwAssert(message: string): never {
	throw new Error(message);
}

function assertStringField(candidate: Record<string, unknown>, field: string, label: string): void {
	requireTrue(typeof candidate[field] === "string", `${label} payload missing string \`${field}\``);
}

function assertSearchPayload(payload: unknown): asserts payload is SearchPayload {
	assertObject(payload, "search");
	assertStringField(payload, "query", "search");
}

function assertTagsPayload(payload: unknown): asserts payload is TagsPayload {
	assertObject(payload, "tags");
	assertStringField(payload, "model", "tags");
}

function pageOf(payload: SearchPayload): number {
	return payload.page ?? 0;
}

export function setupOllamaRegistry(): () => void {
	const handleSearch = async (_event: unknown, payload: unknown) => {
		assertSearchPayload(payload);
		return await searchOllamaLibrary(payload.query, pageOf(payload));
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

function resetCachesForTests(): void {
	searchCache.clear();
	tagsCache.clear();
	catalogCache = null;
}

// Test-only exports for the parser internals — pure functions, no IPC.
export const __ollama_registry_test_helpers__ = {
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
};
