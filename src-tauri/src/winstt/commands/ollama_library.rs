// HTML scraper for the Ollama registry — Ollama publishes no JSON search
// API, so we scrape ollama.com/library, ollama.com/search, and ollama.com/library/<m>/tags with a
// handful of regex extractors (no scraper/cheerio dep). Cached in-process with a short TTL so
// opening/closing the picker repeatedly doesn't hammer Ollama's CDN.
//
// Commands (registered in lib.rs collect_commands![]):
//   - ollama_refresh_library → LLM_FETCH_OLLAMA_LIBRARY  (full catalog, ~230 models, 1h TTL)
//   - ollama_refresh_tags    → LLM_FETCH_OLLAMA_TAGS     (per-model tags)
//   - ollama_search_library  → LLM_SEARCH_OLLAMA_LIBRARY (paginated search — routed but unused by v1
//                                                         renderer; provided for parity)
//
// Payload shapes mirror `spec/openapi.yaml` (OllamaLibraryHit / *SearchResult / *CatalogResult /
// *Tag / *TagsResult) exactly so the reused renderer's `OllamaLibraryStore` parses them unchanged.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::helpers::regex::static_regex;
use crate::winstt::managers::OllamaManager;

const OLLAMA_BASE: &str = "https://ollama.com";
const USER_AGENT: &str = "WinSTT/1.0 (+https://github.com/dahshury/WinSTT)";
const PAGE_SIZE: usize = 20;

// ── Burst control ────────────────────────────────────────────────────────────────
// ollama.com sits behind Cloudflare, which resets excess concurrent connections
// from one client and stalls the queued ones past the timeout. Browsing the library
// fires many tag scrapes at once (one renderer `invoke` per row), so a single
// request always succeeds while the burst fails. The fetch gate (in `OllamaManager`)
// caps concurrency; here we retry the transient drops with backoff.
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
//
// The cache maps + TTLs, the shared `reqwest::Client`, and the burst-control
// `Semaphore` now live on `OllamaManager` (managed state); `fetch_html` borrows them.

// ── HTTP fetcher ────────────────────────────────────────────────────────────────

/// Retry only the burst-induced transients — connection resets and timeouts.
/// HTTP-status errors are deterministic, so re-hitting them just wastes time.
fn is_retryable_fetch_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout() || err.is_request()
}

async fn fetch_html(mgr: &OllamaManager, url: &str) -> Result<String, String> {
    let _permit = mgr
        .fetch_gate()
        .acquire()
        .await
        .map_err(|e| e.to_string())?;
    let mut attempt: u32 = 0;
    loop {
        let send_result = mgr
            .http()
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

static TAG_STRIP_RE: Lazy<Regex> = Lazy::new(|| static_regex(r"<[^>]+>"));

fn strip_tags(s: &str) -> String {
    decode_entities(&TAG_STRIP_RE.replace_all(s, ""))
        .trim()
        .to_string()
}

// ── Search-page parser ──────────────────────────────────────────────────────────

// ollama.com appends utility classes after `group w-full` (e.g. `space-y-5`), so
// match the class prefix tolerantly — the strict `group w-full">` form silently
// matched zero models after a site markup change, emptying the library browse.
static SEARCH_HIT_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"<a\s+href="/library/([^"]+)"\s+class="group w-full[^"]*">"#));
static TITLE_ATTR_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"title="([^"]+)""#));
static DESCRIPTION_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?s)<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>(.*?)</p>"#));
static PULLS_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)<span[^>]*>([\d.,]+[KMB]?)\s*Pulls?</span>"#));
static UPDATED_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)<span[^>]*>Updated\s+([^<]+)</span>"#));
static CAPABILITY_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"<span[^>]*class="[^"]*capability[^"]*"[^>]*>([^<]+)</span>"#));

fn parse_capabilities(block: &str) -> Option<Vec<String>> {
    let caps: Vec<String> = CAPABILITY_RE
        .captures_iter(block)
        .filter_map(|c| c.get(1).map(|m| strip_tags(m.as_str())))
        .filter(|s| !s.is_empty())
        .collect();
    if caps.is_empty() { None } else { Some(caps) }
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
        .map_or_else(|| slug.to_string(), |m| m.as_str().to_string())
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
        let end = anchors.get(i + 1).map_or(html.len(), |(s, _)| *s);
        out.push(parse_search_hit(&html[*start..end], slug));
    }
    out
}

// ── Tag-page parser ─────────────────────────────────────────────────────────────

static TAG_ANCHOR_RE: Lazy<Regex> = Lazy::new(|| {
    static_regex(r#"<a\s+href="/library/([^"]+:[^"]+)"\s+class="md:hidden[^"]*"[^>]*>"#)
});
static SIZE_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"(?i)([\d.]+)\s*(KB|MB|GB|TB)"#));
static CONTEXT_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)([\d.]+[KMB])\s*context\s*window"#));
static QUANT_TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)(?:^|[-:_])(q\d[a-z0-9_]*|fp\d+|int\d+|bf\d+)($|[-:_])"#));
// Optional `e` prefix captures Gemma 3n/4 MatFormer "effective" sizes (`e2b`).
static PARAM_TOKEN_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?:^|[-:_])(e?\d+(?:\.\d+)?[mMbB])($|[-:_])"#));
static LATEST_TAG_RE: Lazy<Regex> = Lazy::new(|| static_regex(r#"(?i)text-blue-600[^>]*>latest<"#));

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
        let end = anchors.get(i + 1).map_or(html.len(), |(s, _)| *s);
        tags.push(build_library_tag(name, &html[*start..end]));
    }
    // The page renders a `:latest` alias first; surface it first, else preserve scrape order.
    tags.sort_by_key(|t| if t.is_latest == Some(true) { 0 } else { 1 });
    tags
}

// ── Model-homepage parser (per-slug rich metadata for typed tags) ────────────────
//
// The `/library/<slug>/tags` page carries sizes/quants but NOT the description or
// capabilities — those live on the model homepage `/library/<slug>`, with different
// markup from the search listing: a `<meta name="description">`, capability badges
// styled `bg-indigo-50`, and `x-test-*` hooks for the pull count / updated stamp.
// This lets a typed tag that isn't in the recommended catalog (e.g. `gpt-oss:20b`)
// fill the same card fields the catalog cards show.

static META_DESC_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?is)<meta\s+name="description"\s+content="([^"]*)""#));
// Capability pills render with the `bg-indigo-50` accent (size pills use blue
// `bg-[#ddf4ff]`), so the accent class disambiguates them from other badges.
static INDIGO_CAP_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)<span[^>]*bg-indigo-50[^>]*>([a-z][a-z0-9 +-]*)</span>"#));
static PULL_COUNT_ATTR_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)x-test-pull-count[^>]*>\s*([\d.,]+\s*[KMB]?)"#));
static UPDATED_ATTR_RE: Lazy<Regex> =
    Lazy::new(|| static_regex(r#"(?i)x-test-updated[^>]*>\s*([^<]+)"#));

// Ollama's capability vocabulary is small and stable; whitelist it so a stray
// indigo-styled span can never masquerade as a capability.
const KNOWN_CAPABILITIES: [&str; 6] = [
    "tools",
    "thinking",
    "vision",
    "embedding",
    "insert",
    "completion",
];

fn parse_homepage_capabilities(html: &str) -> Option<Vec<String>> {
    let mut caps: Vec<String> = Vec::new();
    for c in INDIGO_CAP_RE.captures_iter(html) {
        let Some(m) = c.get(1) else { continue };
        let word = strip_tags(m.as_str()).to_lowercase();
        if KNOWN_CAPABILITIES.contains(&word.as_str()) && !caps.contains(&word) {
            caps.push(word);
        }
    }
    if caps.is_empty() { None } else { Some(caps) }
}

fn parse_model_homepage(html: &str, slug: &str) -> OllamaLibraryHit {
    let description = META_DESC_RE
        .captures(html)
        .and_then(|c| c.get(1))
        .map(|m| decode_entities(m.as_str()).trim().to_string())
        .filter(|s| !s.is_empty());
    OllamaLibraryHit {
        name: slug.to_string(),
        description,
        pulls: first_group(&PULL_COUNT_ATTR_RE, html),
        updated: first_group(&UPDATED_ATTR_RE, html).or_else(|| first_group(&UPDATED_RE, html)),
        capabilities: parse_homepage_capabilities(html),
    }
}

/// Base slug for a typed tag or slug: the part before the first `:` (e.g.
/// `gpt-oss:20b` → `gpt-oss`). Namespaced `user/model` slugs are returned as-is
/// and simply 404 on the library homepage (→ graceful empty hit).
fn homepage_slug(model: &str) -> &str {
    model.split(':').next().unwrap_or(model).trim()
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

async fn scrape_search(
    mgr: &OllamaManager,
    query: &str,
    page: i32,
    cache_key: &str,
) -> OllamaLibrarySearchResult {
    match fetch_html(mgr, &search_url(query, page)).await {
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
            mgr.cache_set_search(cache_key.to_string(), result.clone());
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

async fn search_ollama_library(
    mgr: &OllamaManager,
    query: &str,
    page: i32,
) -> OllamaLibrarySearchResult {
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
    if let Some(cached) = mgr.cache_get_search(&cache_key) {
        return cached;
    }
    scrape_search(mgr, trimmed, page, &cache_key).await
}

async fn fetch_ollama_library_catalog(mgr: &OllamaManager) -> OllamaLibraryCatalogResult {
    if let Some(cached) = mgr.cache_get_catalog() {
        return cached;
    }
    match fetch_html(mgr, &format!("{OLLAMA_BASE}/library")).await {
        Ok(html) => {
            let result = OllamaLibraryCatalogResult {
                hits: parse_search_page(&html),
                error: None,
            };
            mgr.cache_set_catalog(result.clone());
            result
        }
        Err(err) => OllamaLibraryCatalogResult {
            hits: Vec::new(),
            error: Some(describe_error(err)),
        },
    }
}

async fn fetch_ollama_library_tags(mgr: &OllamaManager, model: &str) -> OllamaLibraryTagsResult {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        return OllamaLibraryTagsResult {
            model: trimmed.to_string(),
            tags: Vec::new(),
            error: None,
        };
    }
    let cache_key = trimmed.to_lowercase();
    if let Some(cached) = mgr.cache_get_tags(&cache_key) {
        return cached;
    }
    match fetch_html(
        mgr,
        &format!("{OLLAMA_BASE}/library/{}/tags", encode_component(trimmed)),
    )
    .await
    {
        Ok(html) => {
            let result = OllamaLibraryTagsResult {
                model: trimmed.to_string(),
                tags: parse_tags_page(&html),
                error: None,
            };
            mgr.cache_set_tags(cache_key, result.clone());
            result
        }
        Err(err) => OllamaLibraryTagsResult {
            model: trimmed.to_string(),
            tags: Vec::new(),
            error: Some(describe_error(err)),
        },
    }
}

async fn fetch_ollama_model_hit(mgr: &OllamaManager, model: &str) -> OllamaLibraryHit {
    let slug = homepage_slug(model);
    if slug.is_empty() {
        return OllamaLibraryHit::default();
    }
    let cache_key = slug.to_lowercase();
    if let Some(cached) = mgr.cache_get_hit(&cache_key) {
        return cached;
    }
    match fetch_html(
        mgr,
        &format!("{OLLAMA_BASE}/library/{}", encode_component(slug)),
    )
    .await
    {
        Ok(html) => {
            let hit = parse_model_homepage(&html, slug);
            mgr.cache_set_hit(cache_key, hit.clone());
            hit
        }
        // Degrade gracefully: keep the slug so the card still renders (size/quants
        // come from the tags scrape); don't cache a miss so it retries next time.
        Err(_) => OllamaLibraryHit {
            name: slug.to_string(),
            ..Default::default()
        },
    }
}

// ── Commands ────────────────────────────────────────────────────────────────────

/// `ollama_refresh_library` → `LLM_FETCH_OLLAMA_LIBRARY`. Full library catalog in one shot.
#[tauri::command]
#[specta::specta]
pub async fn ollama_refresh_library(
    ollama_manager: State<'_, Arc<OllamaManager>>,
) -> Result<OllamaLibraryCatalogResult, String> {
    Ok(fetch_ollama_library_catalog(&ollama_manager).await)
}

/// `ollama_refresh_tags` → `LLM_FETCH_OLLAMA_TAGS`. Pullable tags for one library model.
#[tauri::command]
#[specta::specta]
pub async fn ollama_refresh_tags(
    ollama_manager: State<'_, Arc<OllamaManager>>,
    model: String,
) -> Result<OllamaLibraryTagsResult, String> {
    Ok(fetch_ollama_library_tags(&ollama_manager, &model).await)
}

/// `ollama_refresh_model_hit` → `LLM_FETCH_OLLAMA_MODEL_HIT`. Per-slug homepage scrape
/// (description / capabilities / pulls / updated) so a typed tag that isn't in the
/// recommended catalog fills the same card fields the catalog cards show.
#[tauri::command]
#[specta::specta]
pub async fn ollama_refresh_model_hit(
    ollama_manager: State<'_, Arc<OllamaManager>>,
    model: String,
) -> Result<OllamaLibraryHit, String> {
    Ok(fetch_ollama_model_hit(&ollama_manager, &model).await)
}

/// `ollama_search_library` → `LLM_SEARCH_OLLAMA_LIBRARY`. Paginated search (parity; v1 renderer
/// filters the full catalog client-side instead).
#[tauri::command]
#[specta::specta]
pub async fn ollama_search_library(
    ollama_manager: State<'_, Arc<OllamaManager>>,
    query: String,
    page: Option<i32>,
) -> Result<OllamaLibrarySearchResult, String> {
    Ok(search_ollama_library(&ollama_manager, &query, page.unwrap_or(0)).await)
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

    #[test]
    fn homepage_slug_strips_tag() {
        assert_eq!(homepage_slug("gpt-oss:20b"), "gpt-oss");
        assert_eq!(homepage_slug("qwen3"), "qwen3");
        assert_eq!(homepage_slug("  gemma4:e4b  "), "gemma4");
    }

    #[test]
    fn parse_model_homepage_extracts_rich_metadata() {
        let html = r##"
            <meta name="description" content="OpenAI&#39;s open-weight models for reasoning &amp; agents.">
            <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-indigo-600">tools</span>
            <span class="inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-indigo-600">thinking</span>
            <span class="inline-flex items-center rounded-md bg-[#ddf4ff] px-2 py-0.5 text-blue-600">20b</span>
            <span x-test-pull-count>10.7M</span>
            <span x-test-updated>8 months ago</span>
        "##;
        let hit = parse_model_homepage(html, "gpt-oss");
        assert_eq!(hit.name, "gpt-oss");
        assert_eq!(
            hit.description.as_deref(),
            Some("OpenAI's open-weight models for reasoning & agents.")
        );
        assert_eq!(
            hit.capabilities.as_deref(),
            Some(&["tools".to_string(), "thinking".to_string()][..])
        );
        assert_eq!(hit.pulls.as_deref(), Some("10.7M"));
        assert_eq!(hit.updated.as_deref(), Some("8 months ago"));
    }

    #[test]
    fn parse_model_homepage_drops_non_capability_badges() {
        // An unknown indigo-styled word and a blue size pill must not be read as caps.
        let html =
            r##"<span class="bg-indigo-50">sponsored</span><span class="bg-[#ddf4ff]">20b</span>"##;
        let hit = parse_model_homepage(html, "foo");
        assert!(hit.capabilities.is_none());
        assert_eq!(hit.name, "foo");
    }
}
