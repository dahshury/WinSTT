// Faithful Rust port of
// `frontend/electron/ipc/ollama-registry.ts` (the HTML scraper) — Ollama publishes no JSON search
// API, so we scrape ollama.com/library, ollama.com/search, and ollama.com/library/<m>/tags with a
// handful of regex extractors (no scraper/cheerio dep, matching the TS source byte-for-byte on
// payload shape). Cached in-process with a short TTL so opening/closing the picker repeatedly
// doesn't hammer Ollama's CDN.
//
// Commands (registered in lib.rs collect_commands![]):
//   - ollama_fetch_library  → LLM_FETCH_OLLAMA_LIBRARY  (full catalog, ~230 models, 1h TTL)
//   - ollama_fetch_tags     → LLM_FETCH_OLLAMA_TAGS     (per-model tags)
//   - ollama_search_library → LLM_SEARCH_OLLAMA_LIBRARY (paginated search — routed but unused by v1
//                                                         renderer; provided for parity)
//
// Payload shapes mirror `spec/openapi.yaml` (OllamaLibraryHit / *SearchResult / *CatalogResult /
// *Tag / *TagsResult) exactly so the reused renderer's `OllamaLibraryStore` parses them unchanged.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::Semaphore;

const OLLAMA_BASE: &str = "https://ollama.com";
const USER_AGENT: &str = "WinSTT/1.0 (+https://github.com/winstt/WinSTT)";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
// Full library catalog rarely changes — hold it for an hour. Per-tag pages keep the shorter TTL.
const CATALOG_TTL: Duration = Duration::from_secs(60 * 60);
const PAGE_SIZE: usize = 20;

// ── Burst control ────────────────────────────────────────────────────────────────
// ollama.com sits behind Cloudflare, which resets excess concurrent connections
// from one client and stalls the queued ones past the timeout. Browsing the library
// fires many tag scrapes at once (one renderer `invoke` per row), so a single
// request always succeeds while the burst fails. Cap concurrency and retry the
// transient drops with backoff — mirrors `electron/ipc/ollama-registry.ts`.
const MAX_CONCURRENT_FETCHES: usize = 3;
const MAX_FETCH_RETRIES: u32 = 2;
const RETRY_BACKOFF_MS: u64 = 400;

// ── Payload types (mirror spec/openapi.yaml) ────────────────────────────────────

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaLibraryHit {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pulls: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaLibrarySearchResult {
    pub hits: Vec<OllamaLibraryHit>,
    pub has_more: bool,
    pub page: i32,
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaLibraryCatalogResult {
    pub hits: Vec<OllamaLibraryHit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaLibraryTag {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_latest: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OllamaLibraryTagsResult {
    pub model: String,
    pub tags: Vec<OllamaLibraryTag>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── In-process caches (short-TTL like the reference handler) ─────────────────────

struct CacheEntry<T> {
    value: T,
    expires_at: Instant,
}

static SEARCH_CACHE: Lazy<
    Mutex<std::collections::HashMap<String, CacheEntry<OllamaLibrarySearchResult>>>,
> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));
static TAGS_CACHE: Lazy<
    Mutex<std::collections::HashMap<String, CacheEntry<OllamaLibraryTagsResult>>>,
> = Lazy::new(|| Mutex::new(std::collections::HashMap::new()));
static CATALOG_CACHE: Lazy<Mutex<Option<CacheEntry<OllamaLibraryCatalogResult>>>> =
    Lazy::new(|| Mutex::new(None));

fn cache_get_search(key: &str) -> Option<OllamaLibrarySearchResult> {
    let mut map = SEARCH_CACHE.lock().ok()?;
    match map.get(key) {
        Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

fn cache_set_search(key: String, value: OllamaLibrarySearchResult) {
    if let Ok(mut map) = SEARCH_CACHE.lock() {
        map.insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + CACHE_TTL,
            },
        );
    }
}

fn cache_get_tags(key: &str) -> Option<OllamaLibraryTagsResult> {
    let mut map = TAGS_CACHE.lock().ok()?;
    match map.get(key) {
        Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
        Some(_) => {
            map.remove(key);
            None
        }
        None => None,
    }
}

fn cache_set_tags(key: String, value: OllamaLibraryTagsResult) {
    if let Ok(mut map) = TAGS_CACHE.lock() {
        map.insert(
            key,
            CacheEntry {
                value,
                expires_at: Instant::now() + CACHE_TTL,
            },
        );
    }
}

fn cache_get_catalog() -> Option<OllamaLibraryCatalogResult> {
    let guard = CATALOG_CACHE.lock().ok()?;
    match guard.as_ref() {
        Some(e) if e.expires_at > Instant::now() => Some(e.value.clone()),
        _ => None,
    }
}

fn cache_set_catalog(value: OllamaLibraryCatalogResult) {
    if let Ok(mut guard) = CATALOG_CACHE.lock() {
        *guard = Some(CacheEntry {
            value,
            expires_at: Instant::now() + CATALOG_TTL,
        });
    }
}

// ── HTTP fetcher ────────────────────────────────────────────────────────────────

// One shared client (connection pooling + consistent TLS) and one shared slot
// pool across catalog/search/tags scrapes.
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .expect("failed to build reqwest client")
});
static FETCH_GATE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(MAX_CONCURRENT_FETCHES));

/// Retry only the burst-induced transients — connection resets and timeouts.
/// HTTP-status errors are deterministic, so re-hitting them just wastes time.
fn is_retryable_fetch_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout() || err.is_request()
}

async fn fetch_html(url: &str) -> Result<String, String> {
    let _permit = FETCH_GATE.acquire().await.map_err(|e| e.to_string())?;
    let mut attempt: u32 = 0;
    loop {
        let send_result = HTTP_CLIENT
            .get(url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::ACCEPT, "text/html")
            .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
            .send()
            .await;
        match send_result {
            Ok(res) => {
                if !res.status().is_success() {
                    return Err(format!("Ollama returned HTTP {}", res.status().as_u16()));
                }
                return res.text().await.map_err(|e| e.to_string());
            }
            Err(err) => {
                if attempt >= MAX_FETCH_RETRIES || !is_retryable_fetch_error(&err) {
                    return Err(err.to_string());
                }
                let backoff = RETRY_BACKOFF_MS * (1u64 << attempt);
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                attempt += 1;
            }
        }
    }
}

/// Minimal percent-encode for the search query (component, not full URL). Mirrors
/// JS `encodeURIComponent` closely enough for ollama search terms.
fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── HTML entity + tag stripping ─────────────────────────────────────────────────

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

static TAG_STRIP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());

fn strip_tags(s: &str) -> String {
    decode_entities(&TAG_STRIP_RE.replace_all(s, ""))
        .trim()
        .to_string()
}

// ── Search-page parser ──────────────────────────────────────────────────────────

// ollama.com appends utility classes after `group w-full` (e.g. `space-y-5`), so
// match the class prefix tolerantly — the strict `group w-full">` form silently
// matched zero models after a site markup change, emptying the library browse.
static SEARCH_HIT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"<a\s+href="/library/([^"]+)"\s+class="group w-full[^"]*">"#).unwrap()
});
static TITLE_ATTR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"title="([^"]+)""#).unwrap());
static DESCRIPTION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?s)<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>(.*?)</p>"#).unwrap());
static PULLS_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)<span[^>]*>([\d.,]+[KMB]?)\s*Pulls?</span>"#).unwrap());
static UPDATED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)<span[^>]*>Updated\s+([^<]+)</span>"#).unwrap());
static CAPABILITY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"<span[^>]*class="[^"]*capability[^"]*"[^>]*>([^<]+)</span>"#).unwrap()
});

fn parse_capabilities(block: &str) -> Option<Vec<String>> {
    let caps: Vec<String> = CAPABILITY_RE
        .captures_iter(block)
        .filter_map(|c| c.get(1).map(|m| strip_tags(m.as_str())))
        .filter(|s| !s.is_empty())
        .collect();
    if caps.is_empty() {
        None
    } else {
        Some(caps)
    }
}

fn first_group(re: &Regex, block: &str) -> Option<String> {
    re.captures(block)
        .and_then(|c| c.get(1))
        .map(|m| strip_tags(m.as_str()))
}

fn name_from_title(block: &str, slug: &str) -> String {
    TITLE_ATTR_RE
        .captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| slug.to_string())
}

fn parse_search_hit(block: &str, slug: &str) -> OllamaLibraryHit {
    OllamaLibraryHit {
        name: name_from_title(block, slug),
        description: first_group(&DESCRIPTION_RE, block),
        pulls: first_group(&PULLS_RE, block),
        updated: first_group(&UPDATED_RE, block),
        capabilities: parse_capabilities(block),
    }
}

fn is_valid_slug(slug: &str) -> bool {
    !slug.is_empty() && !slug.contains(':') && !slug.contains('/')
}

fn parse_search_page(html: &str) -> Vec<OllamaLibraryHit> {
    let anchors: Vec<(usize, String)> = SEARCH_HIT_RE
        .captures_iter(html)
        .filter_map(|c| {
            let m = c.get(0)?;
            let slug = c.get(1)?.as_str().to_string();
            Some((m.start(), slug))
        })
        .collect();
    let mut out = Vec::with_capacity(anchors.len());
    for (i, (start, slug)) in anchors.iter().enumerate() {
        if !is_valid_slug(slug) {
            continue;
        }
        let end = anchors.get(i + 1).map(|(s, _)| *s).unwrap_or(html.len());
        out.push(parse_search_hit(&html[*start..end], slug));
    }
    out
}

// ── Tag-page parser ─────────────────────────────────────────────────────────────

static TAG_ANCHOR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"<a\s+href="/library/([^"]+:[^"]+)"\s+class="md:hidden[^"]*"[^>]*>"#).unwrap()
});
static SIZE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)([\d.]+)\s*(KB|MB|GB|TB)"#).unwrap());
static CONTEXT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)([\d.]+[KMB])\s*context\s*window"#).unwrap());
static QUANT_TOKEN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)(?:^|[-:_])(q\d[a-z0-9_]*|fp\d+|int\d+|bf\d+)($|[-:_])"#).unwrap()
});
// Optional `e` prefix captures Gemma 3n/4 MatFormer "effective" sizes (`e2b`).
static PARAM_TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:^|[-:_])(e?\d+(?:\.\d+)?[mMbB])($|[-:_])"#).unwrap());
static LATEST_TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)text-blue-600[^>]*>latest<"#).unwrap());

fn size_multiplier(unit: &str) -> u64 {
    match unit.to_uppercase().as_str() {
        "KB" => 1_000,
        "MB" => 1_000_000,
        "GB" => 1_000_000_000,
        "TB" => 1_000_000_000_000,
        _ => 1,
    }
}

/// Returns (bytes, label).
fn parse_size(raw: &str) -> Option<(i64, String)> {
    let caps = SIZE_RE.captures(raw)?;
    let raw_value = caps.get(1)?.as_str();
    let value: f64 = raw_value.parse().ok()?;
    let unit = caps.get(2)?.as_str().to_uppercase();
    let multiplier = size_multiplier(&unit);
    if !value.is_finite() || multiplier == 0 {
        return None;
    }
    let bytes = (value * multiplier as f64).round() as i64;
    Some((bytes, format!("{raw_value}{unit}")))
}

fn suffix_segment(tag: &str) -> &str {
    match tag.split_once(':') {
        Some((_, suffix)) => suffix,
        None => tag,
    }
}

fn parse_quantization(tag: &str) -> Option<String> {
    QUANT_TOKEN_RE
        .captures(suffix_segment(tag))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_uppercase())
}

fn parse_parameter_size(tag: &str) -> Option<String> {
    PARAM_TOKEN_RE
        .captures(suffix_segment(tag))
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_uppercase())
}

fn build_library_tag(name: &str, block: &str) -> OllamaLibraryTag {
    let size = parse_size(block);
    OllamaLibraryTag {
        name: name.to_string(),
        size_bytes: size.as_ref().map(|(b, _)| *b),
        size_label: size.map(|(_, l)| l),
        context_window: CONTEXT_RE
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string()),
        quantization: parse_quantization(name),
        parameter_size: parse_parameter_size(name),
        is_latest: if LATEST_TAG_RE.is_match(block) {
            Some(true)
        } else {
            None
        },
    }
}

fn parse_tags_page(html: &str) -> Vec<OllamaLibraryTag> {
    let anchors: Vec<(usize, String)> = TAG_ANCHOR_RE
        .captures_iter(html)
        .filter_map(|c| {
            let m = c.get(0)?;
            let name = c.get(1)?.as_str().to_string();
            Some((m.start(), name))
        })
        .collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut tags: Vec<OllamaLibraryTag> = Vec::new();
    for (i, (start, name)) in anchors.iter().enumerate() {
        if name.is_empty() || seen.contains(name) {
            continue;
        }
        seen.insert(name.clone());
        let end = anchors.get(i + 1).map(|(s, _)| *s).unwrap_or(html.len());
        tags.push(build_library_tag(name, &html[*start..end]));
    }
    // The page renders a `:latest` alias first; surface it first, else preserve scrape order.
    tags.sort_by_key(|t| if t.is_latest == Some(true) { 0 } else { 1 });
    tags
}

// ── Scrape entry points ─────────────────────────────────────────────────────────

fn describe_error(err: String) -> String {
    if err.is_empty() {
        "Failed to reach ollama.com".to_string()
    } else {
        err
    }
}

fn search_url(query: &str, page: i32) -> String {
    let page_suffix = if page > 0 {
        format!("&p={page}")
    } else {
        String::new()
    };
    format!(
        "{OLLAMA_BASE}/search?q={}{page_suffix}",
        encode_component(query)
    )
}

async fn scrape_search(query: &str, page: i32, cache_key: &str) -> OllamaLibrarySearchResult {
    match fetch_html(&search_url(query, page)).await {
        Ok(html) => {
            let all_hits = parse_search_page(&html);
            let start = (page.max(0) as usize) * PAGE_SIZE;
            let hits: Vec<OllamaLibraryHit> = all_hits
                .iter()
                .skip(start)
                .take(PAGE_SIZE)
                .cloned()
                .collect();
            let has_more = (start + PAGE_SIZE) < all_hits.len();
            let result = OllamaLibrarySearchResult {
                hits,
                has_more,
                page,
                query: query.to_string(),
                error: None,
            };
            cache_set_search(cache_key.to_string(), result.clone());
            result
        }
        Err(err) => OllamaLibrarySearchResult {
            hits: Vec::new(),
            has_more: false,
            page,
            query: query.to_string(),
            error: Some(describe_error(err)),
        },
    }
}

async fn search_ollama_library(query: &str, page: i32) -> OllamaLibrarySearchResult {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return OllamaLibrarySearchResult {
            hits: Vec::new(),
            has_more: false,
            page,
            query: trimmed.to_string(),
            error: None,
        };
    }
    let cache_key = format!("{}::{page}", trimmed.to_lowercase());
    if let Some(cached) = cache_get_search(&cache_key) {
        return cached;
    }
    scrape_search(trimmed, page, &cache_key).await
}

async fn fetch_ollama_library_catalog() -> OllamaLibraryCatalogResult {
    if let Some(cached) = cache_get_catalog() {
        return cached;
    }
    match fetch_html(&format!("{OLLAMA_BASE}/library")).await {
        Ok(html) => {
            let result = OllamaLibraryCatalogResult {
                hits: parse_search_page(&html),
                error: None,
            };
            cache_set_catalog(result.clone());
            result
        }
        Err(err) => OllamaLibraryCatalogResult {
            hits: Vec::new(),
            error: Some(describe_error(err)),
        },
    }
}

async fn fetch_ollama_library_tags(model: &str) -> OllamaLibraryTagsResult {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return OllamaLibraryTagsResult {
            model: trimmed.to_string(),
            tags: Vec::new(),
            error: None,
        };
    }
    let cache_key = trimmed.to_lowercase();
    if let Some(cached) = cache_get_tags(&cache_key) {
        return cached;
    }
    match fetch_html(&format!(
        "{OLLAMA_BASE}/library/{}/tags",
        encode_component(trimmed)
    ))
    .await
    {
        Ok(html) => {
            let result = OllamaLibraryTagsResult {
                model: trimmed.to_string(),
                tags: parse_tags_page(&html),
                error: None,
            };
            cache_set_tags(cache_key, result.clone());
            result
        }
        Err(err) => OllamaLibraryTagsResult {
            model: trimmed.to_string(),
            tags: Vec::new(),
            error: Some(describe_error(err)),
        },
    }
}

// ── Commands ────────────────────────────────────────────────────────────────────

/// `ollama_fetch_library` → `LLM_FETCH_OLLAMA_LIBRARY`. Full library catalog in one shot.
#[tauri::command]
#[specta::specta]
pub async fn ollama_fetch_library() -> Result<OllamaLibraryCatalogResult, String> {
    Ok(fetch_ollama_library_catalog().await)
}

/// `ollama_fetch_tags` → `LLM_FETCH_OLLAMA_TAGS`. Pullable tags for one library model.
#[tauri::command]
#[specta::specta]
pub async fn ollama_fetch_tags(model: String) -> Result<OllamaLibraryTagsResult, String> {
    Ok(fetch_ollama_library_tags(&model).await)
}

/// `ollama_search_library` → `LLM_SEARCH_OLLAMA_LIBRARY`. Paginated search (parity; v1 renderer
/// filters the full catalog client-side instead).
#[tauri::command]
#[specta::specta]
pub async fn ollama_search_library(
    query: String,
    page: Option<i32>,
) -> Result<OllamaLibrarySearchResult, String> {
    Ok(search_ollama_library(&query, page.unwrap_or(0)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_tags_decodes_entities() {
        assert_eq!(strip_tags("<p>a &amp; b</p>"), "a & b");
    }

    #[test]
    fn parse_size_gb() {
        let (bytes, label) = parse_size("3.3GB").unwrap();
        assert_eq!(bytes, 3_300_000_000);
        assert_eq!(label, "3.3GB");
    }

    #[test]
    fn quant_and_param_from_tag() {
        assert_eq!(
            parse_quantization("gemma3:4b-q8_0").as_deref(),
            Some("Q8_0")
        );
        assert_eq!(parse_parameter_size("gemma3:4b").as_deref(), Some("4B"));
    }

    #[test]
    fn encode_component_spaces() {
        assert_eq!(encode_component("a b"), "a%20b");
    }
}
