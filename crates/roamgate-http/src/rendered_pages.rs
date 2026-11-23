//! Pages of rendered reviews (http/rendered-pages.ts, rendered-storage.ts,
//! rendered-helper.ts), served under `/rendered/<token>/<path>`: an HTML
//! file of a checkout with the files around it, a site fetched by this
//! server, or one page held here (an SVG). Requests come from an
//! opaque-origin sandbox (CSP `sandbox` without `allow-same-origin`, on
//! every response), so they carry no Roamgate cookie: the token is the
//! credential, and they run before the authentication gate. A page can
//! never reach Roamgate's origin: its requests there are cross-site and
//! refused like any other site's ([`rendered_stray`]).
//!
//! The host fills the seams: [`PageReader`] (usually a
//! [`ConnectionFileReader`] over [`FileHosts`]), [`RootFinder`] (a
//! [`ConnectionRootFinder`] over [`RootHosts`]), [`SiteFetch`] and the
//! [`SiteStorage`] file. Responses are [`PageResponse`]s, whose body may
//! stream (a local file, a site's response).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use roamgate_base::clock::{BoxFuture, SharedClock};
use sha2::{Digest, Sha256};

mod address;
mod files;
mod html;
mod js;
mod storage;

pub use address::{
    AddressParams, AddressTarget, RenderedAddress, RootOf, SiteRootChoice, listed_directory,
    listed_site, parse_site_url, rendered_address, url_directory, valid_home,
};
pub use files::{
    ConnectionFileReader, ConnectionRootFinder, FileCacheConfig, FileHosts, PageBody, PageReader,
    RENDERED_REMOTE_CACHE_BYTES, RENDERED_REMOTE_CACHE_MS, ReadError, RenderedFile, RootFinder,
    RootHosts, SITE_ROOT_MAX_LEVELS, ScriptOutput, site_root_candidates, site_root_script,
};
pub use html::{
    RootMap, TextKind, inject_helper, localize_own_origin, rendered_helper_source,
    rewrite_root_urls,
};
pub use storage::{
    RENDERED_STORAGE_MAX_CHARS, RENDERED_STORAGE_MAX_KEYS, RENDERED_STORAGE_MAX_SITES, SiteStorage,
    StorageQuotaError, StorageWrite, rendered_storage_path,
};

/// A page's response; its body may stream.
pub type PageResponse = http::Response<PageBody>;

/// Where pages are served from: `/rendered/<token>/<path>`.
pub const RENDERED_PREFIX: &str = "/rendered/";
pub const RENDERED_TTL_MS: i64 = 12 * 60 * 60 * 1000;
pub const RENDERED_MAX_TOKENS: usize = 500;
/// The most a page reads of one file or response, a safety net against a
/// runaway file rather than a size guess: an HTML page or style sheet is
/// read whole to rewrite it, any other response of a site streams, and a
/// file read over SSH comes whole. Larger ones are refused before they are
/// read. Local files other than pages and style sheets stream, unbounded.
pub const RENDERED_BODY_MAX_BYTES: u64 = 512 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
pub const RENDERED_FETCH_TIMEOUT_MS: u64 = 30_000;
/// A root-absolute URL of a page whose site's root is still to be found is
/// written under this segment, so its request says it is one.
pub const RENDERED_ROOT_MARK: &str = ".roamgate-root";
/// How long a root-absolute path found nowhere above is not looked for again.
pub const SITE_ROOT_MISS_MS: i64 = 30_000;
const REQUEST_BODY_MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
/// The most an inline SVG page holds.
pub const RENDERED_SVG_MAX_BYTES: usize = 2 * 1024 * 1024;

fn too_large_page() -> String {
    format!(
        "This page is too large to render here ({} MiB maximum). Use Source or Download from the file menu.",
        RENDERED_BODY_MAX_BYTES / MIB
    )
}

/// static: the page's own scripts are blocked (only Roamgate's runs) and
/// it reaches nothing but its own files. site: a site the user listed, its
/// scripts and forms on, still in an opaque origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RenderedMode {
    Static,
    Site,
}

/// What a token's pages are served from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderedSource {
    /// Files under `root`, an absolute directory on the connection's host.
    /// `site`: the listed directory the pages are of. `walk`: `root` is
    /// that directory as listed, which may not be where the site's
    /// root-absolute links start: one not found there looks for the site's
    /// root in the directories above it ([`RootFinder`]).
    Files {
        root: String,
        site: Option<String>,
        walk: bool,
    },
    /// A site: pages under `base` (an http(s) URL ending in `/`). `site`:
    /// the listed entry the pages are of.
    Url { base: String, site: Option<String> },
    /// One page held here, whole: an SVG drawn by [`rendered_svg_page`].
    Inline { body: String },
}

impl RenderedSource {
    pub fn files(root: impl Into<String>) -> Self {
        Self::Files {
            root: root.into(),
            site: None,
            walk: false,
        }
    }

    pub fn url(base: impl Into<String>) -> Self {
        Self::Url {
            base: base.into(),
            site: None,
        }
    }
}

/// A token's pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedEntry {
    pub connection_id: String,
    pub mode: RenderedMode,
    pub source: RenderedSource,
    /// The directory of the file or URL the frame was opened on, as a path
    /// under the token ("" or ending in `/`, encoded as URLs are).
    pub home: Option<String>,
    pub expires_at: i64,
}

/// What a token is minted for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MintParams {
    pub connection_id: String,
    pub mode: RenderedMode,
    pub source: RenderedSource,
    pub home: Option<String>,
}

impl MintParams {
    pub fn new(
        connection_id: impl Into<String>,
        mode: RenderedMode,
        source: RenderedSource,
    ) -> Self {
        Self {
            connection_id: connection_id.into(),
            mode,
            source,
            home: None,
        }
    }

    pub fn home(mut self, home: Option<String>) -> Self {
        self.home = home;
        self
    }
}

/// A request to a site, never following redirects itself (`redirect:
/// "manual"`), given up after `timeout` (headers and body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SiteRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    pub timeout: Duration,
}

/// A site's answer.
#[derive(Debug)]
pub struct SiteResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: PageBody,
}

/// The pages' fetch of a site (createRenderedPages' `fetch`). An error
/// when the site did not answer.
pub trait SiteFetch: Send + Sync + 'static {
    fn fetch(&self, request: SiteRequest) -> BoxFuture<Result<SiteResponse, String>>;
}

/// An SVG as a page of its own, unsanitized: the static policy (only the
/// helper's script runs, nothing is fetched) is what keeps it inert, and
/// the helper can pause it and draw it. `color` is the theme's text color,
/// for drawings in currentColor.
pub fn rendered_svg_page(svg: &str, color: Option<&str>) -> String {
    static COLOR: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)^(#[0-9a-f]{3,8}|rgba?\([0-9., %]+\))$").unwrap()
    });
    let text = match color {
        Some(color) if COLOR.is_match(color) => format!("color:{color};"),
        _ => String::new(),
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{{margin:0;padding:0;background:transparent;{text}}}svg{{display:block;max-width:100%;height:auto}}</style></head><body>{svg}</body></html>"
    )
}

/// A path's type by its extension.
pub fn rendered_mime(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    let last = lower.rsplit('/').next().unwrap_or("");
    let Some((_, extension)) = last.rsplit_once('.') else {
        return "application/octet-stream";
    };
    match extension {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// The page's policy. Never `allow-same-origin`: the page's origin is
/// opaque, whatever frames it or opens it. Static: only Roamgate's script
/// (its nonce) runs, and the page reaches nothing but its own files. Site:
/// the page's scripts and forms run, and it reaches its own site (through
/// here) and https resources.
pub fn rendered_csp(mode: RenderedMode, nonce: &str) -> String {
    match mode {
        RenderedMode::Static => [
            "sandbox allow-scripts",
            "default-src 'self'",
            &format!("script-src 'nonce-{nonce}'"),
            "style-src 'self' 'unsafe-inline' data:",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "media-src 'self'",
            "connect-src 'none'",
            "form-action 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-src 'self'",
            "worker-src 'none'",
            "frame-ancestors 'self'",
        ]
        .join("; "),
        RenderedMode::Site => [
            "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
            "default-src 'self' https: data: blob:",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
            "style-src 'self' 'unsafe-inline' https: data:",
            "img-src 'self' https: data: blob:",
            "font-src 'self' https: data:",
            "connect-src 'self' https:",
            "form-action 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-ancestors 'self'",
        ]
        .join("; "),
    }
}

/// Response headers in order, as a `Headers` object holds them.
#[derive(Debug, Clone, Default)]
struct Headers(Vec<(String, String)>);

impl Headers {
    fn base(mode: RenderedMode, nonce: &str) -> Self {
        Self(vec![
            ("content-security-policy".into(), rendered_csp(mode, nonce)),
            ("x-content-type-options".into(), "nosniff".into()),
            // A sandboxed page sends no Referer anyway; never leak its token.
            ("referrer-policy".into(), "no-referrer".into()),
            ("cache-control".into(), "private, no-store".into()),
            // The page's origin is opaque: its fonts, modules and fetches to
            // its own files are cross-origin. The token in the path is the
            // credential.
            ("access-control-allow-origin".into(), "*".into()),
            ("cross-origin-resource-policy".into(), "cross-origin".into()),
        ])
    }

    fn set(&mut self, name: &str, value: impl Into<String>) {
        let value = value.into();
        match self.0.iter().position(|(have, _)| have == name) {
            Some(at) => {
                self.0[at].1 = value;
                let mut index = at + 1;
                while index < self.0.len() {
                    if self.0[index].0 == name {
                        self.0.remove(index);
                    } else {
                        index += 1;
                    }
                }
            }
            None => self.0.push((name.to_owned(), value)),
        }
    }

    fn delete(&mut self, name: &str) {
        self.0.retain(|(have, _)| have != name);
    }

    fn response(self, status: u16, body: PageBody) -> PageResponse {
        let mut response = http::Response::new(body);
        *response.status_mut() =
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        for (name, value) in self.0 {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_bytes(value.as_bytes()),
            ) {
                response.headers_mut().append(name, value);
            }
        }
        response
    }
}

fn nonce() -> String {
    base64::engine::general_purpose::STANDARD.encode(rand::random::<[u8; 16]>())
}

fn plain(status: u16, text: &str, mode: RenderedMode) -> PageResponse {
    let mut headers = Headers::base(mode, "none");
    headers.set("content-type", "text/plain; charset=utf-8");
    headers.response(status, text.to_owned().into())
}

fn html_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    crate::response::header(headers, name)
}

/// A page the frame went to that is not there: plain text, but for the
/// frame's own navigation a page saying so too, which tells the preview
/// (it shows the tab's own page again when it was restoring this one) and
/// links back to the page the frame was opened on.
pub fn not_found(text: &str, page: &str, mode: RenderedMode, request: &HeaderMap) -> PageResponse {
    let dest = header(request, "sec-fetch-dest");
    if !matches!(dest.as_deref(), Some("iframe" | "document")) {
        return plain(404, text, mode);
    }
    let nonce = nonce();
    let mut headers = Headers::base(mode, &nonce);
    headers.set("content-type", "text/html; charset=utf-8");
    // Inside a script element: never its end.
    let said = format!(
        "{{\"roamgate\":\"rendered\",\"type\":\"missing\",\"url\":{}}}",
        js::json_string(page)
    )
    .replace('<', "\\u003c");
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Not found</title></head><body style=\"font:14px/1.5 system-ui,sans-serif;margin:16px;color-scheme:light dark\"><pre style=\"white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 12px\">{}</pre><a id=\"roamgate-home\" href=\"#\">Back to the file of this tab</a><script nonce=\"{nonce}\">parent.postMessage({said},\"*\");document.getElementById(\"roamgate-home\").addEventListener(\"click\",function(e){{e.preventDefault();parent.postMessage({{roamgate:\"rendered\",type:\"home\"}},\"*\")}});</script></body></html>",
        html_escape(text)
    );
    headers.response(404, body.into())
}

/// A path under a token, as a relative path of its source: decoded per
/// segment, no `..`, `.`, empty inner segments or NULs. A directory
/// (empty, or ending in `/`) names its index.html. `None` when refused.
pub fn page_path(rest: &str) -> Option<String> {
    let segments: Vec<&str> = rest.split('/').collect();
    let mut out = Vec::with_capacity(segments.len());
    for (index, raw) in segments.iter().enumerate() {
        let segment = crate::response::decode_uri_component(raw)?;
        if segment.is_empty() && index == segments.len() - 1 {
            out.push("index.html".to_owned());
            continue;
        }
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains(['/', '\\', '\0'])
        {
            return None;
        }
        out.push(segment);
    }
    Some(out.join("/"))
}

fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

fn is_css(content_type: &str) -> bool {
    media_type(content_type) == "text/css"
}

fn is_html(content_type: &str) -> bool {
    let media = media_type(content_type);
    media == "text/html" || media == "application/xhtml+xml"
}

/// A request target (path and query) as `new URL(req.url)` reads it: its
/// pathname, dot segments folded, and its search ("" or `?...`).
fn whatwg_target(target: &str) -> Option<(String, String)> {
    let url = url::Url::parse(&format!("http://roamgate.invalid{target}")).ok()?;
    let search = url
        .query()
        .filter(|query| !query.is_empty())
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    Some((url.path().to_owned(), search))
}

/// Whether a token is 32 hex digits.
fn valid_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What makes two tokens the same pages.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Key {
    connection_id: String,
    mode: RenderedMode,
    home: String,
    source: KeySource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum KeySource {
    Files(String, Option<String>, bool),
    Url(String, Option<String>),
    Inline(String),
}

fn key_of(
    connection_id: &str,
    mode: RenderedMode,
    source: &RenderedSource,
    home: Option<&str>,
) -> Key {
    Key {
        connection_id: connection_id.to_owned(),
        mode,
        home: home.unwrap_or("").to_owned(),
        source: match source {
            RenderedSource::Files { root, site, walk } => {
                KeySource::Files(root.clone(), site.clone(), *walk)
            }
            RenderedSource::Url { base, site } => KeySource::Url(base.clone(), site.clone()),
            RenderedSource::Inline { body } => {
                KeySource::Inline(hex::encode(Sha256::digest(body.as_bytes())))
            }
        },
    }
}

#[derive(Default)]
struct State {
    /// Tokens in the order they were made: the oldest go first.
    entries: Vec<(String, RenderedEntry)>,
    /// The root found for a listed directory, per connection.
    site_roots: HashMap<(String, String), String>,
    root_misses: HashMap<(String, String, String), i64>,
}

/// The tunables of [`RenderedPages`].
#[derive(Debug, Clone, Copy)]
pub struct PagesConfig {
    pub ttl_ms: i64,
    pub max_tokens: usize,
    pub fetch_timeout_ms: u64,
}

impl Default for PagesConfig {
    fn default() -> Self {
        Self {
            ttl_ms: RENDERED_TTL_MS,
            max_tokens: RENDERED_MAX_TOKENS,
            fetch_timeout_ms: RENDERED_FETCH_TIMEOUT_MS,
        }
    }
}

/// A request for a page: its method, target (path and query, as sent) and
/// headers. Its body is given apart.
#[derive(Debug, Clone, Copy)]
pub struct PageRequest<'a> {
    pub method: &'a str,
    pub target: &'a str,
    pub headers: &'a HeaderMap,
}

/// The tokens and their pages (createRenderedPages).
pub struct RenderedPages {
    reader: Arc<dyn PageReader>,
    finder: Option<Arc<dyn RootFinder>>,
    fetch: Option<Arc<dyn SiteFetch>>,
    /// What the listed sites' pages keep in `localStorage`: written into
    /// each of their pages, and updated by the page's writes. Absent:
    /// pages have none, as a static page's.
    storage: Option<Arc<SiteStorage>>,
    clock: SharedClock,
    config: PagesConfig,
    state: Mutex<State>,
}

/// The parts of a request [`RenderedPages`] passes along.
struct Asked<'a> {
    method: &'a str,
    headers: &'a HeaderMap,
}

impl RenderedPages {
    pub fn new(reader: Arc<dyn PageReader>, clock: SharedClock) -> Self {
        Self {
            reader,
            finder: None,
            fetch: None,
            storage: None,
            clock,
            config: PagesConfig::default(),
            state: Mutex::new(State::default()),
        }
    }

    pub fn with_root_finder(mut self, finder: Arc<dyn RootFinder>) -> Self {
        self.finder = Some(finder);
        self
    }

    pub fn with_fetch(mut self, fetch: Arc<dyn SiteFetch>) -> Self {
        self.fetch = Some(fetch);
        self
    }

    pub fn with_storage(mut self, storage: Arc<SiteStorage>) -> Self {
        self.storage = Some(storage);
        self
    }

    pub fn with_config(mut self, config: PagesConfig) -> Self {
        self.config = config;
        self
    }

    fn now(&self) -> i64 {
        self.clock.now()
    }

    /// A token for these pages: the same one while it lives, renewed.
    pub fn mint(&self, params: MintParams) -> Result<String, String> {
        let MintParams {
            connection_id,
            mode,
            source,
            home,
        } = params;
        let home = home.filter(|home| !home.is_empty());
        if home.as_deref().is_some_and(|home| !valid_home(home)) {
            return Err("a page's home is a relative directory".to_owned());
        }
        if let RenderedSource::Files { root, .. } = &source
            && !root.starts_with('/')
        {
            return Err("pages are served from an absolute directory".to_owned());
        }
        if let RenderedSource::Url { base, .. } = &source {
            let parsed = url::Url::parse(base).map_err(|_| "Invalid URL".to_owned())?;
            if (parsed.scheme() != "http" && parsed.scheme() != "https")
                || !parsed.username().is_empty()
                || parsed
                    .password()
                    .is_some_and(|password| !password.is_empty())
                || !base.ends_with('/')
            {
                return Err("a site is an http(s) URL prefix".to_owned());
            }
        }
        let now = self.now();
        let mut state = self.state.lock().unwrap();
        state.entries.retain(|(_, entry)| entry.expires_at > now);
        let key = key_of(&connection_id, mode, &source, home.as_deref());
        for (token, entry) in &mut state.entries {
            if key_of(
                &entry.connection_id,
                entry.mode,
                &entry.source,
                entry.home.as_deref(),
            ) == key
            {
                entry.expires_at = now + self.config.ttl_ms;
                return Ok(token.clone());
            }
        }
        // Oldest out first once full.
        while !state.entries.is_empty() && state.entries.len() >= self.config.max_tokens {
            state.entries.remove(0);
        }
        let token = hex::encode(rand::random::<[u8; 16]>());
        state.entries.push((
            token.clone(),
            RenderedEntry {
                connection_id,
                mode,
                source,
                home,
                expires_at: now + self.config.ttl_ms,
            },
        ));
        Ok(token)
    }

    /// The token's pages, while it lives.
    pub fn entry(&self, token: &str) -> Option<RenderedEntry> {
        if !valid_token(token) {
            return None;
        }
        let now = self.now();
        let mut state = self.state.lock().unwrap();
        let at = state.entries.iter().position(|(have, _)| have == token)?;
        if state.entries[at].1.expires_at <= now {
            state.entries.remove(at);
            return None;
        }
        Some(state.entries[at].1.clone())
    }

    pub fn revoke(&self, token: &str) {
        self.state
            .lock()
            .unwrap()
            .entries
            .retain(|(have, _)| have != token);
    }

    /// The root found for a listed directory's site on the connection.
    pub fn site_root(&self, connection_id: &str, site: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .site_roots
            .get(&(connection_id.to_owned(), site.to_owned()))
            .cloned()
    }

    /// The listed site whose pages keep a `localStorage` under `found`:
    /// only the pages of a listed site with its scripts on, never a page
    /// the user turned scripts on for once.
    fn storage_site<'e>(&self, found: &'e RenderedEntry) -> Option<&'e String> {
        if self.storage.is_none() || found.mode != RenderedMode::Site {
            return None;
        }
        match &found.source {
            RenderedSource::Inline { .. } => None,
            RenderedSource::Files { site, .. } | RenderedSource::Url { site, .. } => site.as_ref(),
        }
    }

    /// A write of the frame of `token`'s page to its site's storage. Only
    /// a token of this connection, of a listed site; the site is the
    /// token's, never one the page names. `false` when refused.
    pub fn write_storage(
        &self,
        connection_id: &str,
        token: &str,
        write: &StorageWrite,
    ) -> Result<bool, StorageQuotaError> {
        let Some(found) = self.entry(token) else {
            return Ok(false);
        };
        if found.connection_id != connection_id {
            return Ok(false);
        }
        let Some(site) = self.storage_site(&found) else {
            return Ok(false);
        };
        self.storage.as_ref().unwrap().write(site, write)?;
        Ok(true)
    }

    /// Where the root-absolute URLs of a page under `token` go: a site's
    /// base path onto the token, a listed folder still looking for its
    /// root under the root mark, other files onto the token.
    fn root_map(token: &str, found: &RenderedEntry) -> RootMap {
        let prefix = format!("{RENDERED_PREFIX}{token}/");
        let home = found.home.clone();
        match &found.source {
            RenderedSource::Url { base, .. } => RootMap {
                base: url::Url::parse(base)
                    .map(|url| url.path().to_owned())
                    .unwrap_or_else(|_| "/".to_owned()),
                to: prefix,
                home,
            },
            RenderedSource::Files { walk: true, .. } => RootMap {
                base: "/".to_owned(),
                to: format!("{prefix}{RENDERED_ROOT_MARK}/"),
                home,
            },
            _ => RootMap {
                base: "/".to_owned(),
                to: prefix,
                home,
            },
        }
    }

    /// The site's root for a root-absolute `path` not found in `found`'s
    /// directory: the nearest directory above holding it, remembered for
    /// the site, and a token for the pages from there. `None` when none
    /// holds it.
    async fn find_site_root(&self, found: &RenderedEntry, path: &str) -> Option<String> {
        let RenderedSource::Files {
            root,
            site: Some(site),
            ..
        } = &found.source
        else {
            return None;
        };
        let from = root.trim_end_matches('/').to_owned();
        let known = self.site_root(&found.connection_id, site);
        // The frame's home as a path under the root above: the way down to
        // this directory first.
        let home_under = |top: &str| {
            let below = from
                .get(if top == "/" { 1 } else { top.len() + 1 }..)
                .unwrap_or("");
            format!(
                "{}/{}",
                below
                    .split('/')
                    .map(js::encode_uri_component)
                    .collect::<Vec<_>>()
                    .join("/"),
                found.home.as_deref().unwrap_or("")
            )
        };
        let mint_at = |top: &str| {
            self.mint(MintParams {
                connection_id: found.connection_id.clone(),
                mode: found.mode,
                source: RenderedSource::Files {
                    root: top.to_owned(),
                    site: Some(site.clone()),
                    walk: false,
                },
                home: Some(home_under(top)),
            })
            .ok()
        };
        // Found already by another of the site's links: its pages go there.
        if let Some(known) = known
            && site_root_candidates(&from, "").contains(&known)
        {
            return mint_at(&known);
        }
        let finder = self.finder.as_ref()?;
        let miss_key = (found.connection_id.clone(), root.clone(), path.to_owned());
        if let Some(until) = self.state.lock().unwrap().root_misses.get(&miss_key)
            && *until > self.now()
        {
            return None;
        }
        let above = finder
            .find_root(found.connection_id.clone(), root.clone(), path.to_owned())
            .await;
        // Only a directory above this one, never the one itself or elsewhere.
        let Some(above) = above.filter(|above| {
            above.starts_with('/')
                && !above.contains('\0')
                && !above.split('/').any(|part| part == "." || part == "..")
                && site_root_candidates(&from, "")
                    .iter()
                    .any(|candidate| candidate == above.trim_end_matches('/'))
        }) else {
            let now = self.now();
            let mut state = self.state.lock().unwrap();
            state.root_misses.retain(|_, until| *until > now);
            state.root_misses.insert(miss_key, now + SITE_ROOT_MISS_MS);
            return None;
        };
        let trimmed = above.trim_end_matches('/');
        let top = if trimmed.is_empty() { "/" } else { trimmed };
        self.state
            .lock()
            .unwrap()
            .site_roots
            .insert((found.connection_id.clone(), site.clone()), top.to_owned());
        mint_at(top)
    }

    fn finish_css(
        &self,
        text: &str,
        status: u16,
        mut headers: Headers,
        token: &str,
    ) -> PageResponse {
        headers.delete("content-length");
        headers.delete("content-range");
        headers.delete("accept-ranges");
        let map = self.entry(token).map(|found| Self::root_map(token, &found));
        let body = rewrite_root_urls(text, TextKind::Css, &|path| root_path(map.as_ref(), path));
        headers.response(status, body.into())
    }

    fn finish_html(
        &self,
        text: &str,
        status: u16,
        mut headers: Headers,
        nonce: &str,
        token: &str,
    ) -> PageResponse {
        let found = self.entry(token);
        let map = found.as_ref().map(|found| Self::root_map(token, found));
        let rooted = |path: &str| root_path(map.as_ref(), path);
        let localized;
        let text = if matches!(
            found.as_ref().map(|found| &found.source),
            Some(RenderedSource::Files { .. })
        ) {
            localized = localize_own_origin(text, &rooted);
            localized.as_str()
        } else {
            text
        };
        let html = rewrite_root_urls(text, TextKind::Html, &rooted);
        headers.set("content-type", "text/html; charset=utf-8");
        headers.delete("content-length");
        headers.delete("content-range");
        headers.delete("accept-ranges");
        let items = found
            .as_ref()
            .and_then(|found| self.storage_site(found))
            .map(|site| self.storage.as_ref().unwrap().get(site));
        let body = inject_helper(
            &html,
            nonce,
            &format!("{RENDERED_PREFIX}{token}/"),
            map.as_ref(),
            items.as_deref(),
        );
        headers.response(status, body.into())
    }

    fn redirect(mode: RenderedMode, status: u16, location: String) -> PageResponse {
        let mut headers = Headers::base(mode, "none");
        headers.set("location", location);
        headers.response(status, PageBody::Empty)
    }

    async fn serve_file(
        &self,
        found: RenderedEntry,
        token: String,
        raw_rest: String,
        search: String,
        asked: &Asked<'_>,
    ) -> PageResponse {
        let RenderedSource::Files { root, walk, .. } = &found.source else {
            return plain(404, "not found", found.mode);
        };
        if asked.method != "GET" && asked.method != "HEAD" {
            return plain(405, "method not allowed", found.mode);
        }
        // A root-absolute URL of the page: relative to the site's root.
        let rooted = raw_rest.starts_with(&format!("{RENDERED_ROOT_MARK}/"));
        let rest = if rooted {
            raw_rest[RENDERED_ROOT_MARK.len() + 1..].to_owned()
        } else {
            raw_rest.clone()
        };
        let Some(path) = page_path(&rest) else {
            return plain(400, "invalid path", found.mode);
        };
        let read = self
            .reader
            .read_file(found.connection_id.clone(), root.clone(), path.clone())
            .await;
        let file = match read {
            Ok(file) => file,
            Err(error) => {
                if rooted
                    && *walk
                    && error.status != Some(413)
                    && let Some(next) = self.find_site_root(&found, &path).await
                {
                    // A page needs the new token for its relative
                    // links; anything else is served from the site's
                    // root at once, as a redirect would break a style
                    // sheet loaded with CORS and an integrity hash
                    // from the sandboxed page's opaque origin.
                    let next_entry = if is_html(rendered_mime(&path)) {
                        None
                    } else {
                        self.entry(&next)
                    };
                    if let Some(next_entry) = next_entry
                        && matches!(next_entry.source, RenderedSource::Files { .. })
                    {
                        return Box::pin(self.serve_file(next_entry, next, rest, search, asked))
                            .await;
                    }
                    return Self::redirect(
                        found.mode,
                        307,
                        format!("{RENDERED_PREFIX}{next}/{rest}{search}"),
                    );
                }
                // A file read over SSH and over its limit.
                if error.status == Some(413) {
                    return plain(
                        413,
                        &format!(
                            "{path} is too large to read here ({} MiB maximum).",
                            RENDERED_BODY_MAX_BYTES / MIB
                        ),
                        found.mode,
                    );
                }
                // Which file was tried, and why, so the frame says it.
                let reason = error.message.split('\n').next().unwrap_or("");
                let reason = if reason.is_empty() {
                    String::new()
                } else {
                    format!("\n{reason}")
                };
                return not_found(
                    &format!("not found: {}/{path}{reason}", root.trim_end_matches('/')),
                    &format!("{raw_rest}{search}"),
                    found.mode,
                    asked.headers,
                );
            }
        };
        // A directory reads as an archive: its index instead.
        if file.content_type == "application/gzip" && !GZIP_NAME.is_match(&path) {
            let slashed = if rest.ends_with('/') {
                rest.clone()
            } else {
                format!("{rest}/")
            };
            return Self::redirect(
                found.mode,
                308,
                format!("{RENDERED_PREFIX}{token}/{slashed}"),
            );
        }
        let content_type = rendered_mime(&path);
        // A page reached by a root-absolute link found here: at its own
        // address, so its relative links and what it reports stay plain.
        if rooted && is_html(content_type) {
            drop(file.body);
            return Self::redirect(
                found.mode,
                307,
                format!("{RENDERED_PREFIX}{token}/{rest}{search}"),
            );
        }
        let nonce = nonce();
        let mut headers = Headers::base(found.mode, &nonce);
        headers.set("content-type", content_type);
        if is_html(content_type) {
            if file.size > RENDERED_BODY_MAX_BYTES {
                return plain(413, &too_large_page(), found.mode);
            }
            if asked.method == "HEAD" {
                drop(file.body);
                return headers.response(200, PageBody::Empty);
            }
            return match file.body.bytes().await {
                Ok(bytes) => {
                    self.finish_html(&files::decoded(&bytes), 200, headers, &nonce, &token)
                }
                Err(error) => read_failed(&error, found.mode),
            };
        }
        if is_css(content_type) && asked.method != "HEAD" {
            if file.size > RENDERED_BODY_MAX_BYTES {
                return plain(
                    413,
                    &format!(
                        "{path} is too large a style sheet ({} MiB maximum).",
                        RENDERED_BODY_MAX_BYTES / MIB
                    ),
                    found.mode,
                );
            }
            return match file.body.bytes().await {
                Ok(bytes) => self.finish_css(&files::decoded(&bytes), 200, headers, &token),
                Err(error) => read_failed(&error, found.mode),
            };
        }
        headers.set("content-length", file.size.to_string());
        let body = if asked.method == "HEAD" {
            PageBody::Empty
        } else {
            file.body
        };
        headers.response(200, body)
    }

    fn serve_inline(
        &self,
        found: &RenderedEntry,
        token: &str,
        rest: &str,
        method: &str,
    ) -> PageResponse {
        let RenderedSource::Inline { body } = &found.source else {
            return plain(404, "not found", found.mode);
        };
        if method != "GET" && method != "HEAD" {
            return plain(405, "method not allowed", found.mode);
        }
        if !rest.is_empty() && rest != "index.html" {
            return plain(404, "not found", found.mode);
        }
        let nonce = nonce();
        let mut headers = Headers::base(found.mode, &nonce);
        headers.set("content-type", "text/html; charset=utf-8");
        if method == "HEAD" {
            return headers.response(200, PageBody::Empty);
        }
        self.finish_html(body, 200, headers, &nonce, token)
    }

    async fn serve_site<S, E>(
        &self,
        found: &RenderedEntry,
        token: &str,
        rest: &str,
        search: &str,
        asked: &Asked<'_>,
        body: Option<S>,
    ) -> PageResponse
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
    {
        let RenderedSource::Url { base, .. } = &found.source else {
            return plain(404, "not found", found.mode);
        };
        let allowed: &[&str] = if found.mode == RenderedMode::Site {
            &["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
        } else {
            &["GET", "HEAD"]
        };
        if !allowed.contains(&asked.method) {
            return plain(405, "method not allowed", found.mode);
        }
        let Some(target) = url::Url::parse(base)
            .and_then(|base| base.join(&format!("{rest}{search}")))
            .ok()
            .map(|url| url.to_string())
        else {
            return plain(400, "invalid path", found.mode);
        };
        if !target.starts_with(base.as_str()) {
            return plain(404, "outside the site", found.mode);
        }
        let mut headers = Vec::new();
        for name in FORWARDED_REQUEST_HEADERS {
            if let Some(value) = header(asked.headers, name) {
                headers.push(((*name).to_owned(), value));
            }
        }
        let mut sent = None;
        if asked.method != "GET" && asked.method != "HEAD" {
            match read_request(body, REQUEST_BODY_MAX_BYTES).await {
                Some(bytes) => sent = Some(bytes),
                None => return plain(413, "request too large", found.mode),
            }
        }
        let Some(fetch) = self.fetch.as_ref() else {
            return plain(502, "the site did not answer", found.mode);
        };
        let timeout = Duration::from_millis(self.config.fetch_timeout_ms);
        let mut response: Option<SiteResponse> = None;
        let mut current = target;
        for _ in 0..=MAX_REDIRECTS {
            let asked_site = fetch.fetch(SiteRequest {
                url: current.clone(),
                method: asked.method.to_owned(),
                headers: headers.clone(),
                body: sent.clone(),
                timeout,
            });
            let answer =
                match roamgate_base::clock::timeout(&*self.clock, timeout, asked_site).await {
                    Ok(Ok(answer)) => answer,
                    _ => return plain(502, "the site did not answer", found.mode),
                };
            if answer.status < 300 || answer.status >= 400 {
                response = Some(answer);
                break;
            }
            let Some(location) = header(&answer.headers, "location") else {
                response = Some(answer);
                break;
            };
            let Some(next) = url::Url::parse(&current)
                .and_then(|current| current.join(&location))
                .ok()
                .map(|url| url.to_string())
            else {
                return plain(502, "the site redirected nowhere", found.mode);
            };
            let Some(inside) = next.strip_prefix(base.as_str()) else {
                return plain(
                    502,
                    &format!("the site redirected off itself: {}", js::head(&next, 300)),
                    found.mode,
                );
            };
            // A navigation follows in the frame, so its address stays
            // true; anything else is followed here.
            if header(asked.headers, "sec-fetch-dest").as_deref() == Some("iframe")
                || header(asked.headers, "sec-fetch-mode").as_deref() == Some("navigate")
            {
                return Self::redirect(
                    found.mode,
                    answer.status,
                    format!("{RENDERED_PREFIX}{token}/{inside}"),
                );
            }
            current = next;
        }
        let Some(response) = response else {
            return plain(502, "too many redirects", found.mode);
        };
        let nonce = nonce();
        let mut out = Headers::base(found.mode, &nonce);
        for name in FORWARDED_RESPONSE_HEADERS {
            if let Some(value) = header(&response.headers, name) {
                out.set(name, value);
            }
        }
        let content_type = header(&response.headers, "content-type").unwrap_or_else(|| {
            let path = url::Url::parse(&current)
                .map(|url| url.path().to_owned())
                .unwrap_or_default();
            rendered_mime(&path).to_owned()
        });
        out.set("content-type", content_type.clone());
        if is_html(&content_type) && asked.method != "HEAD" {
            return match response.body.capped(RENDERED_BODY_MAX_BYTES).await {
                Ok(Some(bytes)) => {
                    self.finish_html(&files::decoded(&bytes), response.status, out, &nonce, token)
                }
                Ok(None) => plain(413, "page too large", found.mode),
                Err(_) => plain(502, "the site did not answer", found.mode),
            };
        }
        if is_css(&content_type) && asked.method != "HEAD" {
            return match response.body.capped(RENDERED_BODY_MAX_BYTES).await {
                Ok(Some(bytes)) => {
                    self.finish_css(&files::decoded(&bytes), response.status, out, token)
                }
                Ok(None) => plain(413, "style sheet too large", found.mode),
                Err(_) => plain(502, "the site did not answer", found.mode),
            };
        }
        let length = header(&response.headers, "content-length");
        if let Some(length) = &length
            && js_number(length).is_some_and(|size| size > RENDERED_BODY_MAX_BYTES as f64)
        {
            return plain(413, "response too large", found.mode);
        }
        if let Some(length) = length {
            out.set("content-length", length);
        }
        let body = if asked.method == "HEAD" {
            PageBody::Empty
        } else {
            response.body.cut_off_past(RENDERED_BODY_MAX_BYTES)
        };
        out.response(response.status, body)
    }

    /// The response for a `/rendered/` path; `None` for any other path.
    /// `body`: the request's, read only by a site's pages.
    pub async fn handle<S, E>(
        &self,
        request: PageRequest<'_>,
        body: Option<S>,
    ) -> Option<PageResponse>
    where
        S: Stream<Item = Result<Bytes, E>> + Unpin + Send,
    {
        let (pathname, search) = whatwg_target(request.target)?;
        let after = pathname.strip_prefix(RENDERED_PREFIX)?;
        let (token, rest) = after.split_once('/').unwrap_or((after, ""));
        let Some(found) = self.entry(token) else {
            return Some(plain(
                404,
                "this page expired: open it again from Roamgate",
                RenderedMode::Static,
            ));
        };
        let asked = Asked {
            method: request.method,
            headers: request.headers,
        };
        Some(match &found.source {
            RenderedSource::Inline { .. } => self.serve_inline(&found, token, rest, request.method),
            RenderedSource::Files { .. } => {
                self.serve_file(
                    found.clone(),
                    token.to_owned(),
                    rest.to_owned(),
                    search,
                    &asked,
                )
                .await
            }
            RenderedSource::Url { .. } => {
                self.serve_site(&found, token, rest, &search, &asked, body)
                    .await
            }
        })
    }
}

/// Request headers passed to a site; never cookies, credentials, origin.
const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "content-type",
    "range",
    "if-none-match",
    "if-modified-since",
    "if-range",
];
/// Response headers passed back from a site; never Set-Cookie.
const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "content-language",
];

static GZIP_NAME: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.t?gz$").unwrap());

/// `Number(text)` for a header: `None` when not a number.
fn js_number(text: &str) -> Option<f64> {
    let text = js::trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    text.parse::<f64>().ok().filter(|number| !number.is_nan())
}

/// A body read that failed midway: the server's error, as Bun's.
fn read_failed(error: &std::io::Error, mode: RenderedMode) -> PageResponse {
    tracing::warn!(target: "rendered", error = %error, "rendered page unreadable");
    plain(500, "Internal Server Error", mode)
}

/// The request's body, or `None` past `max` bytes (readCapped).
async fn read_request<S, E>(body: Option<S>, max: u64) -> Option<Bytes>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let Some(mut body) = body else {
        return Some(Bytes::new());
    };
    let mut out = bytes::BytesMut::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.ok()?;
        out.extend_from_slice(&chunk);
        if out.len() as u64 > max {
            return None;
        }
    }
    Some(out.freeze())
}

/// A root-absolute path of a page, as a path under its token.
fn root_path(map: Option<&RootMap>, path: &str) -> Option<String> {
    let map = map?;
    path.strip_prefix(map.base.as_str())
        .map(|rest| format!("{}{rest}", map.to))
}

const NOT_PART: &str = "not part of this site";

/// A request a page's frame made off its token, for a path of Roamgate's:
/// a navigation a page's script built (`location.href = "/docs/x.html"`)
/// or a fetch the helper could not write under its token. The frame's
/// opaque origin makes it cross-site and cookieless, and it sends no
/// Referer to tell whose it is: Roamgate's login page (or any route behind
/// the gate) is never what it gets. A frame's navigation gets a page
/// saying so, whose script hands the path to the parent, which knows the
/// token; anything else from an opaque origin a 404. `None` for any other
/// request: the authentication gate decides those.
pub fn rendered_stray(target: &str, headers: &HeaderMap) -> Option<PageResponse> {
    let (pathname, search) = whatwg_target(target)?;
    if pathname.starts_with(RENDERED_PREFIX) {
        return None;
    }
    if header(headers, "sec-fetch-site").as_deref() != Some("cross-site") {
        return None;
    }
    let dest = header(headers, "sec-fetch-dest");
    if !matches!(dest.as_deref(), Some("iframe" | "frame")) {
        if header(headers, "origin").as_deref() == Some("null") {
            return Some(plain(
                404,
                &format!("{NOT_PART}: {}", js::head(&pathname, 300)),
                RenderedMode::Static,
            ));
        }
        return None;
    }
    let nonce = nonce();
    let mut out = Headers::base(RenderedMode::Static, &nonce);
    out.set("content-type", "text/html; charset=utf-8");
    let mut path = String::new();
    for c in js::head(&format!("{pathname}{search}"), 300).chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => path.push_str(&format!("&#{};", c as u32)),
            _ => path.push(c),
        }
    }
    let script = "try{parent.postMessage({roamgate:\"rendered\",type:\"stray\",url:(location.pathname+location.search).slice(0,2048)},\"*\")}catch(e){}";
    Some(out.response(
        404,
        format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Not part of this site</title><style>body{{font:14px system-ui,sans-serif;margin:2em;color:#555}}code{{word-break:break-all}}</style></head><body><p>This address is {NOT_PART}: <code>{path}</code></p><script nonce=\"{nonce}\">{script}</script></body></html>"
        )
        .into(),
    ))
}

#[cfg(test)]
mod tests;
