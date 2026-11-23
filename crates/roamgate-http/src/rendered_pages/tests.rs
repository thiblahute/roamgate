//! http/rendered-pages.test.ts, case for case; its cases that run the
//! helper in a page (happy-dom) are tests/rendered_helper_dom.rs.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::LazyLock;

use futures_util::stream;

use super::*;
use crate::test_support::{ManualClock, shared};

type NoBody = stream::Iter<std::vec::IntoIter<Result<Bytes, Infallible>>>;
type Log = Arc<Mutex<Vec<String>>>;

struct Reader<F>(F);

impl<F> PageReader for Reader<F>
where
    F: Fn(&str, &str, &str) -> Result<RenderedFile, ReadError> + Send + Sync + 'static,
{
    fn read_file(
        &self,
        connection_id: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>> {
        let out = (self.0)(&connection_id, &root, &path);
        Box::pin(async move { out })
    }
}

fn reader<F>(read: F) -> Arc<dyn PageReader>
where
    F: Fn(&str, &str, &str) -> Result<RenderedFile, ReadError> + Send + Sync + 'static,
{
    Arc::new(Reader(read))
}

fn unused() -> Arc<dyn PageReader> {
    reader(|_, _, _| Err(ReadError::new("unused")))
}

fn file_of(text: &str, content_type: &str) -> RenderedFile {
    RenderedFile {
        body: PageBody::Full(Bytes::copy_from_slice(text.as_bytes())),
        size: text.len() as u64,
        content_type: content_type.to_owned(),
    }
}

fn octets(text: &str) -> RenderedFile {
    file_of(text, "application/octet-stream")
}

fn log() -> Log {
    Arc::new(Mutex::new(Vec::new()))
}

fn logged(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

fn clock() -> Arc<ManualClock> {
    ManualClock::at(1_000)
}

fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        map.append(
            HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value).unwrap(),
        );
    }
    map
}

async fn ask(
    pages: &RenderedPages,
    path: &str,
    headers: &[(&str, &str)],
    method: &str,
) -> Option<PageResponse> {
    let headers = header_map(headers);
    pages
        .handle(
            PageRequest {
                method,
                target: path,
                headers: &headers,
            },
            None::<NoBody>,
        )
        .await
}

async fn get(pages: &RenderedPages, path: &str) -> PageResponse {
    ask(pages, path, &[], "GET").await.unwrap()
}

async fn text(response: PageResponse) -> String {
    let bytes = response.into_body().bytes().await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

async fn get_text(pages: &RenderedPages, path: &str) -> String {
    text(get(pages, path).await).await
}

fn hdr(response: &PageResponse, name: &str) -> Option<String> {
    crate::response::header(response.headers(), name)
}

fn nonce_of(csp: &str) -> String {
    let at = csp.find("'nonce-").unwrap() + "'nonce-".len();
    csp[at..].split('\'').next().unwrap().to_owned()
}

fn mint_files(pages: &RenderedPages, connection: &str, mode: RenderedMode, root: &str) -> String {
    pages
        .mint(MintParams::new(
            connection,
            mode,
            RenderedSource::files(root),
        ))
        .unwrap()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

const SITE_FILES: &[(&str, &str)] = &[
    (
        "/site/index.html",
        "<!doctype html><html><head><title>Home</title></head><body><script>alert(1)</script>hi</body></html>",
    ),
    ("/site/style.css", "body{color:red}"),
    ("/site/docs/page.html", "<p>no head here</p>"),
];

fn file_pages(clock: &Arc<ManualClock>) -> (RenderedPages, Log) {
    let reads = log();
    let seen = reads.clone();
    let pages = RenderedPages::new(
        reader(move |_, root, path| {
            seen.lock().unwrap().push(format!("{root}|{path}"));
            let at = format!("{root}/{path}");
            match SITE_FILES.iter().find(|(name, _)| *name == at) {
                Some((_, text)) => Ok(octets(text)),
                None if at == "/site/docs" => Ok(file_of("", "application/gzip")),
                None => Err(ReadError::new("no such file")),
            }
        }),
        shared(clock),
    );
    (pages, reads)
}

// tokens

#[tokio::test]
async fn are_128_bit_hex_reused_for_the_same_pages_and_expire() {
    let now = clock();
    let (pages, _) = file_pages(&now);
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    assert!(valid_token(&token));
    assert_eq!(
        mint_files(&pages, "c", RenderedMode::Static, "/site"),
        token
    );
    // Another mode is another token: a listing must not widen old ones.
    assert_ne!(mint_files(&pages, "c", RenderedMode::Site, "/site"), token);
    assert!(pages.entry(&token).is_some());
    now.advance(12 * 60 * 60 * 1000 + 1);
    assert!(pages.entry(&token).is_none());
    let expired = get(&pages, &format!("/rendered/{token}/index.html")).await;
    assert_eq!(expired.status(), 404);
}

#[test]
fn are_bounded_oldest_out_first() {
    let pages = RenderedPages::new(unused(), shared(&clock())).with_config(PagesConfig {
        max_tokens: 2,
        ..PagesConfig::default()
    });
    let first = mint_files(&pages, "c", RenderedMode::Static, "/a");
    mint_files(&pages, "c", RenderedMode::Static, "/b");
    mint_files(&pages, "c", RenderedMode::Static, "/c");
    assert!(pages.entry(&first).is_none());
}

#[test]
fn refuse_relative_roots_and_non_http_sites() {
    let (pages, _) = file_pages(&clock());
    let mint = |source| pages.mint(MintParams::new("c", RenderedMode::Static, source));
    assert!(mint(RenderedSource::files("site")).is_err());
    assert!(mint(RenderedSource::url("file:///etc/")).is_err());
    assert!(mint(RenderedSource::url("http://u:p@x/")).is_err());
}

#[tokio::test]
async fn unknown_or_malformed_tokens_are_404() {
    let (pages, _) = file_pages(&clock());
    assert_eq!(get(&pages, "/rendered/nope/index.html").await.status(), 404);
    let zeros = format!("/rendered/{}/x", "0".repeat(32));
    assert_eq!(get(&pages, &zeros).await.status(), 404);
    assert!(ask(&pages, "/api/health", &[], "GET").await.is_none());
}

// paths

#[test]
fn stay_inside_their_source() {
    assert_eq!(page_path("a/b.html").as_deref(), Some("a/b.html"));
    assert_eq!(page_path("").as_deref(), Some("index.html"));
    assert_eq!(page_path("docs/").as_deref(), Some("docs/index.html"));
    assert_eq!(page_path("a%20b.html").as_deref(), Some("a b.html"));
    for bad in [
        "../x",
        "a/../../x",
        "%2e%2e/x",
        "a//b",
        "a/%2Fetc",
        "./x",
        "a%00b",
        "%E0%A4%A",
    ] {
        assert_eq!(page_path(bad), None, "{bad}");
    }
}

// policies

#[test]
fn never_allow_the_same_origin_and_frame_only_in_roamgate() {
    for mode in [RenderedMode::Static, RenderedMode::Site] {
        let csp = rendered_csp(mode, "N");
        assert!(csp.starts_with("sandbox allow-scripts"));
        assert!(!csp.contains("allow-same-origin"));
        assert!(!csp.contains("allow-top-navigation"));
        assert!(!csp.contains("allow-popups-to-escape-sandbox"));
        assert!(csp.contains("frame-ancestors 'self'"));
    }
}

#[test]
fn static_runs_only_roamgates_script_and_reaches_nothing() {
    let csp = rendered_csp(RenderedMode::Static, "N0nce");
    assert!(csp.contains("script-src 'nonce-N0nce'"));
    assert!(csp.contains("connect-src 'none'"));
    assert!(csp.contains("form-action 'none'"));
    assert!(!csp.contains("allow-forms"));
    assert!(!csp.contains("unsafe-inline' 'unsafe-eval"));
}

#[test]
fn a_listed_site_runs_its_scripts_and_forms() {
    let csp = rendered_csp(RenderedMode::Site, "N");
    assert!(csp.contains("allow-forms"));
    assert!(csp.contains("script-src 'self' 'unsafe-inline'"));
    // A nonce would turn 'unsafe-inline' off.
    assert!(!csp.contains("nonce-"));
}

// serving files

#[tokio::test]
async fn html_gets_the_helper_under_a_nonce_the_pages_scripts_blocked() {
    let (pages, _) = file_pages(&clock());
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let response = get(&pages, &format!("/rendered/{token}/")).await;
    assert_eq!(response.status(), 200);
    let csp = hdr(&response, "content-security-policy").unwrap();
    let nonce = nonce_of(&csp);
    assert_eq!(
        hdr(&response, "content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        hdr(&response, "referrer-policy").as_deref(),
        Some("no-referrer")
    );
    assert_eq!(
        hdr(&response, "x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert_eq!(
        hdr(&response, "cache-control").as_deref(),
        Some("private, no-store")
    );
    assert_eq!(hdr(&response, "set-cookie"), None);
    let html = text(response).await;
    assert!(html.contains(&format!("<head><script nonce=\"{nonce}\">")));
    assert!(html.contains(&js::json_string(&format!("/rendered/{token}/"))));
    // The page's own script has no nonce: the policy blocks it.
    assert!(html.contains("<script>alert(1)</script>"));
}

#[tokio::test]
async fn other_files_keep_their_type_and_the_sandbox() {
    let (pages, _) = file_pages(&clock());
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let response = get(&pages, &format!("/rendered/{token}/style.css")).await;
    assert_eq!(
        hdr(&response, "content-type").as_deref(),
        Some("text/css; charset=utf-8")
    );
    assert!(
        hdr(&response, "content-security-policy")
            .unwrap()
            .starts_with("sandbox allow-scripts")
    );
    assert_eq!(text(response).await, "body{color:red}");
}

#[tokio::test]
async fn says_which_file_was_not_found_and_why() {
    let (pages, _) = file_pages(&clock());
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site/");
    let response = get(&pages, &format!("/rendered/{token}/out/casa.html")).await;
    assert_eq!(response.status(), 404);
    assert_eq!(
        text(response).await,
        "not found: /site/out/casa.html\nno such file"
    );
}

#[tokio::test]
async fn in_the_frame_a_page_saying_so_tells_the_preview_and_links_back() {
    let (pages, _) = file_pages(&clock());
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site/");
    let response = ask(
        &pages,
        &format!("/rendered/{token}/out/%3Cb%3E.html?x=1"),
        &[("sec-fetch-dest", "iframe")],
        "GET",
    )
    .await
    .unwrap();
    assert_eq!(response.status(), 404);
    assert_eq!(
        hdr(&response, "content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    let nonce = nonce_of(&hdr(&response, "content-security-policy").unwrap());
    let html = text(response).await;
    // Text, never markup.
    assert!(html.contains("not found: /site/out/&lt;b&gt;.html\nno such file"));
    assert!(html.contains(&format!("<script nonce=\"{nonce}\">")));
    assert!(html.contains(
        "{\"roamgate\":\"rendered\",\"type\":\"missing\",\"url\":\"out/%3Cb%3E.html?x=1\"}"
    ));
    assert!(html.contains("type:\"home\""));
    assert!(html.contains("Back to the file of this tab"));
}

#[tokio::test]
async fn refuses_escapes_writes_and_sends_directories_to_their_index() {
    let (pages, reads) = file_pages(&clock());
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let at = |rest: &str| format!("/rendered/{token}/{rest}");
    // The URL parser already folds the dot segments: never the file.
    assert_eq!(get(&pages, &at("%2e%2e/etc/passwd")).await.status(), 404);
    assert_eq!(get(&pages, &at("a%2f..%2f..%2fetc")).await.status(), 400);
    let posted = ask(&pages, &at("index.html"), &[], "POST").await.unwrap();
    assert_eq!(posted.status(), 405);
    assert!(logged(&reads).is_empty());
    let dir = get(&pages, &at("docs")).await;
    assert_eq!(dir.status(), 308);
    assert_eq!(hdr(&dir, "location"), Some(at("docs/")));
    assert_eq!(get(&pages, &at("missing.html")).await.status(), 404);
}

#[test]
fn a_page_without_head_still_gets_the_helper_first() {
    let inject = |html: &str, prefix: &str| inject_helper(html, "n", prefix, None, None);
    assert!(inject("<p>x</p>", "/p/").starts_with("<script nonce=\"n\">"));
    assert!(
        inject("<!DOCTYPE html><p>x</p>", "/p/").starts_with("<!DOCTYPE html><script nonce=\"n\">")
    );
    assert!(inject("<html lang=\"en\"><body>", "/p/").starts_with("<html lang=\"en\"><script"));
    // The prefix cannot close the script.
    assert!(!inject("", "</script>").contains("</script></script>"));
}

// the helper and links

#[test]
fn a_link_neither_drags_nor_swallows_a_selection_point_mode_keeps_its_crosshair() {
    let source = inject_helper("<p>x</p>", "n", "/p/", None, None);
    for part in [
        "-webkit-user-drag: none",
        "user-select: text",
        "a:empty { pointer-events: none; }",
        "data-roamgate-point",
        "cursor: crosshair !important",
        "selection.isCollapsed",
    ] {
        assert!(source.contains(part), "{part}");
    }
}

#[test]
fn a_click_on_a_card_follows_its_empty_link_after_a_delay_mousemove_shows_a_pointer() {
    let source = inject_helper("<p>x</p>", "n", "/p/", None, None);
    for part in [
        "\"a:empty[href]\"",
        "event.detail > 1",
        "}, 250)",
        "[role=button], [contenteditable]",
        "style.cursor = over ? \"pointer\" : \"\"",
    ] {
        assert!(source.contains(part), "{part}");
    }
}

// large files

/// Pages serving one HTML file, plan.html, of about `page_bytes`; its read
/// says `claimed` instead when given, as a stat would.
fn sized_pages(page_bytes: usize, claimed: Option<u64>) -> RenderedPages {
    let page = format!(
        "<!doctype html><html><head></head><body>{}</body></html>",
        "x".repeat(page_bytes - 50)
    );
    RenderedPages::new(
        reader(move |_, _, path| {
            if path != "plan.html" {
                return Err(ReadError::new("no such file"));
            }
            let mut file = octets(&page);
            if let Some(claimed) = claimed {
                file.size = claimed;
            }
            Ok(file)
        }),
        shared(&clock()),
    )
}

#[tokio::test]
async fn a_600_kb_page_is_served_whole_past_the_text_previews_512_kib() {
    let pages = sized_pages(600 * 1000, None);
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let response = get(&pages, &format!("/rendered/{token}/plan.html")).await;
    assert_eq!(response.status(), 200);
    let html = text(response).await;
    assert!(html.contains("<head><script nonce="));
    assert!(html.len() > 600 * 1000);
}

#[tokio::test]
async fn a_17_mb_page_is_served_whole() {
    let pages = sized_pages(17 * 1000 * 1000, None);
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let response = get(&pages, &format!("/rendered/{token}/plan.html")).await;
    assert_eq!(response.status(), 200);
    let html = text(response).await;
    assert!(html.contains("<head><script nonce="));
    assert!(html.len() > 17 * 1000 * 1000);
}

#[tokio::test]
async fn a_page_over_its_limit_is_refused_with_the_reason() {
    // Said by its size, refused before a byte of it is read.
    let pages = sized_pages(100, Some(RENDERED_BODY_MAX_BYTES + 1));
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let response = get(&pages, &format!("/rendered/{token}/plan.html")).await;
    assert_eq!(response.status(), 413);
    assert_eq!(
        hdr(&response, "content-type").as_deref(),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(
        text(response).await,
        "This page is too large to render here (512 MiB maximum). Use Source or Download from the file menu."
    );
}

type ReadFn = dyn Fn(&str, &str, &str) -> Result<RenderedFile, ReadError> + Send + Sync;

/// The host's side of the reader: its connections' SSH destinations and
/// the download helpers.
struct Hosts {
    ssh: fn(&str) -> Option<String>,
    local: Box<ReadFn>,
    remote: Box<ReadFn>,
}

impl FileHosts for Hosts {
    fn ssh_host(&self, connection_id: &str) -> Option<String> {
        (self.ssh)(connection_id)
    }
    fn read_local(&self, root: String, path: String) -> BoxFuture<Result<RenderedFile, ReadError>> {
        let out = (self.local)("", &root, &path);
        Box::pin(async move { out })
    }
    fn read_remote(
        &self,
        host: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>> {
        let out = (self.remote)(&host, &root, &path);
        Box::pin(async move { out })
    }
}

#[tokio::test]
async fn a_model_over_the_ssh_caches_limit_is_served_read_each_time() {
    let reads = log();
    let seen = reads.clone();
    let model = vec![7u8; 2048];
    let read = ConnectionFileReader::new(
        Arc::new(Hosts {
            ssh: |_| Some("mac".to_owned()),
            local: Box::new(|_, _, _| Err(ReadError::new("local"))),
            remote: Box::new(move |_, _, path| {
                seen.lock().unwrap().push(path.to_owned());
                if path != "casa.glb" {
                    return Err(ReadError::new("no such file"));
                }
                Ok(RenderedFile {
                    body: PageBody::Full(Bytes::from(model.clone())),
                    size: model.len() as u64,
                    content_type: "application/octet-stream".to_owned(),
                })
            }),
        }),
        shared(&clock()),
        FileCacheConfig {
            cache_bytes: 1024,
            ..FileCacheConfig::default()
        },
    );
    let pages = RenderedPages::new(Arc::new(read), shared(&clock()));
    let token = mint_files(&pages, "mac", RenderedMode::Site, "/Users/me/casa");
    for _ in 0..2 {
        let response = get(&pages, &format!("/rendered/{token}/casa.glb")).await;
        assert_eq!(response.status(), 200);
        assert_eq!(hdr(&response, "content-length").as_deref(), Some("2048"));
        assert_eq!(response.into_body().bytes().await.unwrap().len(), 2048);
    }
    assert_eq!(logged(&reads), strings(&["casa.glb", "casa.glb"]));
}

#[tokio::test]
async fn a_file_the_ssh_read_refuses_as_too_large_says_so() {
    let pages = RenderedPages::new(
        reader(|_, _, _| Err(ReadError::too_large("File is too large"))),
        shared(&clock()),
    );
    let token = mint_files(&pages, "mac", RenderedMode::Site, "/Users/me/casa");
    let response = get(&pages, &format!("/rendered/{token}/huge.glb")).await;
    assert_eq!(response.status(), 413);
    assert_eq!(
        text(response).await,
        "huge.glb is too large to read here (512 MiB maximum)."
    );
}

// serving a site

type Answer = dyn Fn(&SiteRequest) -> SiteResponse + Send + Sync;

struct Site {
    answer: Box<Answer>,
    calls: Arc<Mutex<Vec<SiteRequest>>>,
}

impl SiteFetch for Site {
    fn fetch(&self, request: SiteRequest) -> BoxFuture<Result<SiteResponse, String>> {
        let out = (self.answer)(&request);
        self.calls.lock().unwrap().push(request);
        Box::pin(async move { Ok(out) })
    }
}

fn answer(status: u16, headers: &[(&str, &str)], body: &str) -> SiteResponse {
    SiteResponse {
        status,
        headers: header_map(headers),
        body: if body.is_empty() {
            PageBody::Empty
        } else {
            PageBody::Full(Bytes::copy_from_slice(body.as_bytes()))
        },
    }
}

type Calls = Arc<Mutex<Vec<SiteRequest>>>;

fn site_pages(
    respond: impl Fn(&SiteRequest) -> SiteResponse + Send + Sync + 'static,
    mode: RenderedMode,
) -> (RenderedPages, String, Calls) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let pages = RenderedPages::new(unused(), shared(&clock())).with_fetch(Arc::new(Site {
        answer: Box::new(respond),
        calls: calls.clone(),
    }));
    let token = pages
        .mint(MintParams::new(
            "c",
            mode,
            RenderedSource::url("http://localhost:8080/docs/"),
        ))
        .unwrap();
    (pages, token, calls)
}

fn sent_header(request: &SiteRequest, name: &str) -> Option<String> {
    request
        .headers
        .iter()
        .find(|(have, _)| have == name)
        .map(|(_, value)| value.clone())
}

#[tokio::test]
async fn never_forwards_credentials_never_returns_cookies() {
    let (pages, token, calls) = site_pages(
        |_| {
            answer(
                200,
                &[
                    ("content-type", "text/html"),
                    ("set-cookie", "x=1"),
                    ("access-control-allow-origin", "https://evil.example"),
                    ("content-security-policy", "default-src *"),
                ],
                "<html><head></head></html>",
            )
        },
        RenderedMode::Site,
    );
    let response = ask(
        &pages,
        &format!("/rendered/{token}/a/b.html?q=1"),
        &[
            ("cookie", "roamgate_session=secret"),
            ("authorization", "Bearer secret"),
            ("origin", "null"),
            ("referer", "https://roamgate.example/x"),
            ("accept", "text/html"),
        ],
        "GET",
    )
    .await
    .unwrap();
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls[0].url, "http://localhost:8080/docs/a/b.html?q=1");
    for name in ["cookie", "authorization", "origin", "referer"] {
        assert_eq!(sent_header(&calls[0], name), None, "{name}");
    }
    assert_eq!(
        sent_header(&calls[0], "accept").as_deref(),
        Some("text/html")
    );
    // `redirect: "manual"`: SiteFetch never follows (its contract); a
    // redirect comes back to the pages, as the next case shows.
    assert_eq!(hdr(&response, "set-cookie"), None);
    assert_eq!(
        hdr(&response, "access-control-allow-origin").as_deref(),
        Some("*")
    );
    assert!(
        hdr(&response, "content-security-policy")
            .unwrap()
            .starts_with("sandbox allow-scripts allow-forms")
    );
    assert!(text(response).await.contains("<head><script nonce="));
}

#[tokio::test]
async fn stays_on_the_site() {
    let (pages, token, calls) = site_pages(|_| answer(200, &[], "x"), RenderedMode::Site);
    assert_eq!(
        get(&pages, &format!("/rendered/{token}/../secret"))
            .await
            .status(),
        404
    );
    assert_eq!(
        get(&pages, &format!("/rendered/{token}/%2e%2e/secret"))
            .await
            .status(),
        404
    );
    assert!(calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn follows_redirects_within_the_site_only() {
    let hops = Arc::new(Mutex::new(0));
    let counted = hops.clone();
    let (pages, token, calls) = site_pages(
        move |request| {
            *counted.lock().unwrap() += 1;
            let url = request.url.as_str();
            if url.ends_with("/old.css") {
                answer(301, &[("location", "new.css")], "")
            } else if url.ends_with("/away") {
                answer(302, &[("location", "http://169.254.169.254/latest")], "")
            } else if url.ends_with("/nav") {
                answer(302, &[("location", "/docs/there.html")], "")
            } else {
                answer(200, &[("content-type", "text/css")], "body{}")
            }
        },
        RenderedMode::Site,
    );
    let urls = || -> Vec<String> {
        calls
            .lock()
            .unwrap()
            .iter()
            .map(|call| call.url.clone())
            .collect()
    };
    let followed = get(&pages, &format!("/rendered/{token}/old.css")).await;
    assert_eq!(followed.status(), 200);
    assert_eq!(
        urls(),
        strings(&[
            "http://localhost:8080/docs/old.css",
            "http://localhost:8080/docs/new.css"
        ])
    );
    let off = get(&pages, &format!("/rendered/{token}/away")).await;
    assert_eq!(off.status(), 502);
    assert_eq!(urls().last().unwrap(), "http://localhost:8080/docs/away");
    let nav = ask(
        &pages,
        &format!("/rendered/{token}/nav"),
        &[("sec-fetch-dest", "iframe"), ("sec-fetch-mode", "navigate")],
        "GET",
    )
    .await
    .unwrap();
    assert_eq!(nav.status(), 302);
    assert_eq!(
        hdr(&nav, "location"),
        Some(format!("/rendered/{token}/there.html"))
    );
    assert_eq!(*hops.lock().unwrap(), 4);
}

#[tokio::test]
async fn static_sites_only_read() {
    let (pages, token, _) = site_pages(|_| answer(200, &[], "x"), RenderedMode::Static);
    let posted = ask(&pages, &format!("/rendered/{token}/form"), &[], "POST")
        .await
        .unwrap();
    assert_eq!(posted.status(), 405);
}

// renderedAddress

fn files_source(root: &str, site: Option<&str>, walk: bool) -> RenderedSource {
    RenderedSource::Files {
        root: root.to_owned(),
        site: site.map(str::to_owned),
        walk,
    }
}

fn url_source(base: &str, site: Option<&str>) -> RenderedSource {
    RenderedSource::Url {
        base: base.to_owned(),
        site: site.map(str::to_owned),
    }
}

#[test]
fn an_html_file_is_served_from_its_checkout_or_its_listed_folder() {
    assert_eq!(
        rendered_address(&AddressParams::new(
            AddressTarget::Path("docs/site/index.html"),
            "/repo",
            &[]
        )),
        Ok(RenderedAddress {
            mode: RenderedMode::Static,
            source: files_source("/repo", None, false),
            rest: "docs/site/index.html".into(),
            site: None,
            home: Some("docs/site/".into()),
        })
    );
    let sites = strings(&["/repo/docs/"]);
    let mut params =
        AddressParams::new(AddressTarget::Path("docs/site/index.html"), "/repo", &sites);
    params.page = Some("sub/p.html?x=1");
    assert_eq!(
        rendered_address(&params),
        Ok(RenderedAddress {
            mode: RenderedMode::Site,
            source: files_source("/repo/docs", Some("/repo/docs/"), true),
            rest: "sub/p.html?x=1".into(),
            site: Some("/repo/docs/".into()),
            home: Some("site/".into()),
        })
    );
}

#[test]
fn refuses_escapes_and_non_html_files() {
    for path in ["../x.html", "/etc/x.html", "a/./b.html", "plan.md"] {
        assert!(
            rendered_address(&AddressParams::new(AddressTarget::Path(path), "/repo", &[])).is_err(),
            "{path}"
        );
    }
    let mut params = AddressParams::new(AddressTarget::Path("a.html"), "/repo", &[]);
    params.page = Some("../x");
    assert!(rendered_address(&params).is_err());
}

#[test]
fn a_url_is_served_from_its_directory_or_its_listed_site() {
    assert_eq!(
        rendered_address(&AddressParams::new(
            AddressTarget::Url(Some("http://localhost:8080/docs/a/b.html?q#frag")),
            "/",
            &[]
        )),
        Ok(RenderedAddress {
            mode: RenderedMode::Static,
            source: url_source("http://localhost:8080/docs/a/", None),
            rest: "b.html?q".into(),
            site: None,
            home: None,
        })
    );
    let sites = strings(&["http://localhost:8080/"]);
    let mut params = AddressParams::new(
        AddressTarget::Url(Some("http://localhost:8080/docs/a/b.html")),
        "/",
        &sites,
    );
    params.page = Some("/docs/c.html");
    assert_eq!(
        rendered_address(&params),
        Ok(RenderedAddress {
            mode: RenderedMode::Site,
            source: url_source("http://localhost:8080/", Some("http://localhost:8080/")),
            rest: "docs/c.html".into(),
            site: Some("http://localhost:8080/".into()),
            home: Some("docs/a/".into()),
        })
    );
    let mut evil = AddressParams::new(
        AddressTarget::Url(Some("http://localhost:8080/docs/a.html")),
        "/",
        &[],
    );
    evil.page = Some("http://evil/");
    assert!(rendered_address(&evil).is_err());
    assert!(
        rendered_address(&AddressParams::new(
            AddressTarget::Url(Some("javascript:alert(1)")),
            "/",
            &[]
        ))
        .is_err()
    );
}

// rewriteRootUrls

fn token_map(path: &str) -> Option<String> {
    (!path.starts_with("/off")).then(|| format!("/rendered/T{path}"))
}

#[test]
fn writes_a_pages_root_absolute_urls_under_its_token() {
    assert_eq!(
        rewrite_root_urls(
            r#"<link href="/a.css"><script src='/b.js?v=1'></script><img src=/c.png srcset="/d.png 1x, e.png 2x, /f.png 3x"><a href="//cdn/x">x</a><a href="rel.html">r</a><a href="/off/x">o</a><div style="background:url(/g.png)"></div><form action="/s"></form>"#,
            TextKind::Html,
            &token_map,
        ),
        r#"<link href="/rendered/T/a.css"><script src='/rendered/T/b.js?v=1'></script><img src="/rendered/T/c.png" srcset="/rendered/T/d.png 1x, e.png 2x, /rendered/T/f.png 3x"><a href="//cdn/x">x</a><a href="rel.html">r</a><a href="/off/x">o</a><div style="background:url(/rendered/T/g.png)"></div><form action="/rendered/T/s"></form>"#
    );
}

#[test]
fn and_a_style_sheets() {
    assert_eq!(
        rewrite_root_urls(
            r#"@import "/base.css"; a{background:url("/i.png")} b{background:url(data:x)} c{src:url(//x/y)}"#,
            TextKind::Css,
            &token_map,
        ),
        r#"@import "/rendered/T/base.css"; a{background:url("/rendered/T/i.png")} b{background:url(data:x)} c{src:url(//x/y)}"#
    );
}

#[tokio::test]
async fn site_pages_map_onto_their_base() {
    let (pages, token, _) = site_pages(
        |_| {
            answer(
                200,
                &[("content-type", "text/html")],
                r#"<a href="/docs/b.html">b</a><a href="/other">o</a>"#,
            )
        },
        RenderedMode::Static,
    );
    let html = get_text(&pages, &format!("/rendered/{token}/a.html")).await;
    assert!(html.contains(&format!("href=\"/rendered/{token}/b.html\"")));
    assert!(html.contains("href=\"/other\""));
}

// a site's own origin

fn origin_page(canonical: &str) -> String {
    format!(
        r#"<!doctype html><html><head>{canonical}<link rel="icon" href="http://localhost:1315/favicon.ico"><link rel="stylesheet" href="http://localhost:1315/css/a.css" integrity="sha256-x" crossorigin="anonymous"><meta property="og:image" content="http://localhost:1315/i.png"></head><body><a class="entry-link" href='http://localhost:1315/2019/04/slug/'>c</a><a href="http://localhost:9999/x/">other</a><a href="https://example.org/y">ext</a><img srcset="http://localhost:1315/a.png 1x, http://localhost:1315/b.png 2x"><div style="background:url(http://localhost:1315/bg.png)"></div></body></html>"#
    )
}

async fn serve_page(html: String) -> (String, String) {
    let pages = RenderedPages::new(reader(move |_, _, _| Ok(octets(&html))), shared(&clock()));
    let token = mint_files(&pages, "c", RenderedMode::Static, "/site");
    let text = get_text(&pages, &format!("/rendered/{token}/index.html")).await;
    (token, text)
}

fn no_map(_: &str) -> Option<String> {
    None
}

#[tokio::test]
async fn a_dev_server_canonicals_urls_go_under_the_token() {
    let (token, text) = serve_page(origin_page(
        r#"<link rel="canonical" href="http://localhost:1315/">"#,
    ))
    .await;
    let at = format!("/rendered/{token}");
    for part in [
        format!("href='{at}/2019/04/slug/'"),
        format!("href=\"{at}/favicon.ico\""),
        format!("href=\"{at}/css/a.css\""),
        format!("content=\"{at}/i.png\""),
        format!("srcset=\"{at}/a.png 1x, {at}/b.png 2x\""),
        format!("url({at}/bg.png)"),
        // The canonical itself, other ports and other hosts stay.
        format!("href=\"{at}/\""),
        "href=\"http://localhost:9999/x/\"".to_owned(),
        "href=\"https://example.org/y\"".to_owned(),
    ] {
        assert!(text.contains(&part), "{part}");
    }
}

#[test]
fn og_url_counts_with_other_attribute_orders() {
    let out = localize_own_origin(
        r#"<meta content="http://127.0.0.1:8080/" property="og:url"><a href=http://127.0.0.1:8080/p>p</a>"#,
        &no_map,
    );
    assert!(out.contains("<a href=\"/p\">"), "{out}");
}

#[tokio::test]
async fn a_published_canonicals_urls_go_under_the_token_other_origins_stay() {
    let (token, text) = serve_page(origin_page(
        r#"<link rel="canonical" href="https://example.org/">"#,
    ))
    .await;
    assert!(text.contains(&format!("href=\"/rendered/{token}/y\"")));
    assert!(text.contains("href=\"http://localhost:1315/favicon.ico\""));
    assert!(text.contains("href='http://localhost:1315/2019/04/slug/'"));
}

#[test]
fn a_canonical_that_is_not_http_leaves_the_page_alone() {
    let html = origin_page(r#"<link rel="canonical" href="ftp://example.org/">"#);
    assert_eq!(localize_own_origin(&html, &no_map), html);
}

#[test]
fn a_page_without_a_canonical_is_unchanged() {
    let html = origin_page("");
    assert_eq!(localize_own_origin(&html, &no_map), html);
}

// an SVG as a page of its own

fn not_a_file() -> Arc<dyn PageReader> {
    reader(|_, _, _| Err(ReadError::new("not a file")))
}

#[tokio::test]
async fn static_only_the_helper_runs_the_svg_is_left_as_it_is() {
    let pages = RenderedPages::new(not_a_file(), shared(&clock()));
    let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><animate attributeName="x"/></svg>"#;
    let token = pages
        .mint(MintParams::new(
            "c",
            RenderedMode::Static,
            RenderedSource::Inline {
                body: rendered_svg_page(svg, Some("#abc")),
            },
        ))
        .unwrap();
    let response = get(&pages, &format!("/rendered/{token}/")).await;
    assert_eq!(response.status(), 200);
    let csp = hdr(&response, "content-security-policy").unwrap();
    assert!(csp.starts_with("sandbox allow-scripts;"));
    assert!(!csp.contains("allow-same-origin"));
    assert!(csp.contains("script-src 'nonce-"));
    assert!(csp.contains("connect-src 'none'"));
    let nonce = nonce_of(&csp);
    let html = text(response).await;
    // The helper's script has the nonce; the SVG's own does not.
    assert!(html.contains(&format!("<script nonce=\"{nonce}\">")));
    assert!(html.contains("<script>alert(1)</script>"));
    assert!(html.contains("color:#abc;"));
}

#[tokio::test]
async fn other_paths_under_its_token_are_not_found() {
    let pages = RenderedPages::new(not_a_file(), shared(&clock()));
    let token = pages
        .mint(MintParams::new(
            "c",
            RenderedMode::Static,
            RenderedSource::Inline {
                body: rendered_svg_page("<svg/>", None),
            },
        ))
        .unwrap();
    assert_eq!(
        get(&pages, &format!("/rendered/{token}/other.png"))
            .await
            .status(),
        404
    );
}

// scripts asked for on one file or site

fn with_scripts(target: AddressTarget<'_>, root: &str, sites: &[String]) -> RenderedAddress {
    let mut params = AddressParams::new(target, root, sites);
    params.scripts = true;
    rendered_address(&params).unwrap()
}

#[test]
fn a_file_runs_its_scripts_served_from_its_folder_alone() {
    assert_eq!(
        with_scripts(AddressTarget::Path("docs/site/page.html"), "/repo", &[]),
        RenderedAddress {
            mode: RenderedMode::Site,
            source: files_source("/repo/docs/site", None, false),
            rest: "page.html".into(),
            site: None,
            home: None,
        }
    );
}

#[test]
fn a_listed_folder_still_serves_the_folder() {
    let address = with_scripts(
        AddressTarget::Path("docs/site/page.html"),
        "/repo",
        &strings(&["/repo/docs/"]),
    );
    assert_eq!(address.mode, RenderedMode::Site);
    assert!(
        matches!(address.source, RenderedSource::Files { ref root, .. } if root == "/repo/docs")
    );
}

#[test]
fn a_url_runs_its_scripts_in_its_own_directory() {
    let address = with_scripts(
        AddressTarget::Url(Some("http://localhost:8080/docs/a.html")),
        "/",
        &[],
    );
    assert_eq!(address.mode, RenderedMode::Site);
    assert_eq!(
        address.source,
        url_source("http://localhost:8080/docs/", None)
    );
}

#[test]
fn off_by_default() {
    let address = rendered_address(&AddressParams::new(
        AddressTarget::Path("a.html"),
        "/repo",
        &[],
    ))
    .unwrap();
    assert_eq!(address.mode, RenderedMode::Static);
}

// files of a connection over SSH

/// A Mac reached over SSH, as the download helpers read it: confined.
const MAC_FILES: &[(&str, &str)] = &[
    (
        "/Users/me/logs/docs/build/index.html",
        r#"<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><a href="sub/page.html">p</a></body></html>"#,
    ),
    ("/Users/me/logs/docs/build/css/site.css", "body{color:blue}"),
    (
        "/Users/me/logs/docs/build/sub/page.html",
        r#"<html><head><link rel="stylesheet" href="../css/site.css"></head></html>"#,
    ),
    ("/Users/me/logs/docs/secret.txt", "not served"),
    ("/etc/passwd", "root:x:0:0"),
];

struct Ssh {
    pages: RenderedPages,
    read: ConnectionFileReader,
    remote: Log,
    local: Log,
}

fn ssh_connection() -> Ssh {
    let remote = log();
    let local = log();
    let (remote_seen, local_seen) = (remote.clone(), local.clone());
    let read = ConnectionFileReader::new(
        Arc::new(Hosts {
            ssh: |id| (id == "mac").then(|| "me@mac".to_owned()),
            local: Box::new(move |_, root, path| {
                local_seen.lock().unwrap().push(format!("{root}|{path}"));
                Err(ReadError::new("not on this host"))
            }),
            remote: Box::new(move |host, root, path| {
                remote_seen
                    .lock()
                    .unwrap()
                    .push(format!("{host}:{root}|{path}"));
                // As downloadRemoteFile: a relative path stays under the root.
                let target = format!("{root}/{path}");
                if !target.starts_with(&format!("{root}/")) || target.contains("/../") {
                    return Err(ReadError::new("outside the root"));
                }
                MAC_FILES
                    .iter()
                    .find(|(name, _)| *name == target)
                    .map(|(_, text)| octets(text))
                    .ok_or_else(|| ReadError::new("no such file"))
            }),
        }),
        shared(&clock()),
        FileCacheConfig::default(),
    );
    let pages = RenderedPages::new(Arc::new(read.clone()), shared(&clock()));
    Ssh {
        pages,
        read,
        remote,
        local,
    }
}

#[tokio::test]
async fn a_page_outside_any_checkout_is_served_with_its_relative_resources() {
    let Ssh {
        pages,
        remote,
        local,
        ..
    } = ssh_connection();
    // Not in a Git checkout on the Mac: the page's directory is the root
    // (review/rendered-target.ts renderedFileTarget, the review crate's).
    let (root, path) = ("/Users/me/logs/docs/build", "index.html");
    let address =
        rendered_address(&AddressParams::new(AddressTarget::Path(path), root, &[])).unwrap();
    assert_eq!(address.mode, RenderedMode::Static);
    let token = pages
        .mint(MintParams::new("mac", address.mode, address.source.clone()))
        .unwrap();
    let page = get(&pages, &format!("/rendered/{token}/{}", address.rest)).await;
    assert_eq!(page.status(), 200);
    assert!(
        hdr(&page, "content-security-policy")
            .unwrap()
            .starts_with("sandbox allow-scripts;")
    );
    assert!(text(page).await.contains("href=\"css/site.css\""));
    let css = get(&pages, &format!("/rendered/{token}/css/site.css")).await;
    assert_eq!(css.status(), 200);
    assert_eq!(
        hdr(&css, "content-type").as_deref(),
        Some("text/css; charset=utf-8")
    );
    assert_eq!(text(css).await, "body{color:blue}");
    // Another page of the site, and its style sheet one level up.
    assert_eq!(
        get(&pages, &format!("/rendered/{token}/sub/page.html"))
            .await
            .status(),
        200
    );
    assert_eq!(
        logged(&remote),
        strings(&[
            "me@mac:/Users/me/logs/docs/build|index.html",
            "me@mac:/Users/me/logs/docs/build|css/site.css",
            "me@mac:/Users/me/logs/docs/build|sub/page.html",
        ])
    );
    assert!(logged(&local).is_empty());
}

#[tokio::test]
async fn escapes_are_refused_before_anything_is_read() {
    let Ssh {
        pages,
        read,
        remote,
        ..
    } = ssh_connection();
    let token = mint_files(
        &pages,
        "mac",
        RenderedMode::Site,
        "/Users/me/logs/docs/build",
    );
    for path in [
        "%2e%2e/secret.txt",
        "sub/%2e%2e/%2e%2e/secret.txt",
        "a%2f..%2f..%2fsecret.txt",
        "..%2fsecret.txt",
        "%2fetc%2fpasswd",
        "/etc/passwd",
        "sub%5c..%5c..%5csecret.txt",
    ] {
        let response = get(&pages, &format!("/rendered/{token}/{path}")).await;
        assert!([400, 404].contains(&response.status().as_u16()), "{path}");
        let body = text(response).await;
        assert!(!body.contains("not served"));
        assert!(!body.contains("root:x"));
    }
    for path in ["../secret.txt", "/etc/passwd", "a/./b", "a//b", ""] {
        let error = read
            .read_file(
                "mac".into(),
                "/Users/me/logs/docs/build".into(),
                path.into(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.message, "invalid path", "{path}");
    }
    let error = read
        .read_file("mac".into(), "relative".into(), "index.html".into())
        .await
        .unwrap_err();
    assert_eq!(error.message, "invalid path");
    assert!(logged(&remote).is_empty());
}

#[tokio::test]
async fn a_token_is_its_connections_the_same_path_elsewhere_is_another_page() {
    let Ssh {
        pages,
        remote,
        local,
        ..
    } = ssh_connection();
    let source = RenderedSource::files("/Users/me/logs/docs/build");
    let mac = pages
        .mint(MintParams::new("mac", RenderedMode::Static, source.clone()))
        .unwrap();
    let here = pages
        .mint(MintParams::new("local", RenderedMode::Static, source))
        .unwrap();
    assert_ne!(mac, here);
    assert_eq!(
        get(&pages, &format!("/rendered/{here}/index.html"))
            .await
            .status(),
        404
    );
    assert_eq!(
        logged(&local),
        strings(&["/Users/me/logs/docs/build|index.html"])
    );
    assert!(logged(&remote).is_empty());
}

#[tokio::test]
async fn a_remote_file_is_kept_a_few_seconds_small_ones_only() {
    let now = clock();
    let reads = log();
    let seen = reads.clone();
    let big = "x".repeat(64);
    let big_text = big.clone();
    let read = ConnectionFileReader::new(
        Arc::new(Hosts {
            ssh: |id| (id == "mac" || id == "other").then(|| "mac".to_owned()),
            local: Box::new(|_, _, _| Err(ReadError::new("local"))),
            remote: Box::new(move |_, root, path| {
                seen.lock().unwrap().push(format!("{root}|{path}"));
                let text = if path == "big.js" {
                    big_text.clone()
                } else {
                    format!("{root}/{path}")
                };
                Ok(octets(&text))
            }),
        }),
        shared(&now),
        FileCacheConfig {
            cache_ms: 1_000,
            cache_file_bytes: Some(32),
            ..FileCacheConfig::default()
        },
    );
    let text_of = |connection: &'static str, path: &'static str| {
        let read = read.clone();
        async move {
            let file = read
                .read_file(connection.into(), "/r".into(), path.into())
                .await
                .unwrap();
            String::from_utf8(file.body.bytes().await.unwrap().to_vec()).unwrap()
        }
    };
    assert_eq!(text_of("mac", "a.css").await, "/r/a.css");
    assert_eq!(text_of("mac", "a.css").await, "/r/a.css");
    assert_eq!(logged(&reads), strings(&["/r|a.css"]));
    // Another connection, even to the same host, reads its own.
    text_of("other", "a.css").await;
    assert_eq!(logged(&reads).len(), 2);
    // Too large to keep.
    assert_eq!(text_of("mac", "big.js").await, big);
    text_of("mac", "big.js").await;
    let count = |name: &str| logged(&reads).iter().filter(|read| *read == name).count();
    assert_eq!(count("/r|big.js"), 2);
    // Read again once its time is up.
    now.advance(1_000);
    text_of("mac", "a.css").await;
    // mac, other, then mac again.
    assert_eq!(count("/r|a.css"), 3);
}

// a listed directory's site root

/// gst-docs is built for a site rooted at gst-docs/, and the folder listed
/// is gst-docs/documentation/: its links are /documentation/...
static TREE: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        (
            "/home/me/build/gst-docs/documentation/index.html",
            r#"<a href="/documentation/libs.html">libs</a><link rel="stylesheet" href="/assets/s.css">"#,
        ),
        (
            "/home/me/build/gst-docs/documentation/libs.html",
            r#"<a href="gst.html">gst</a>"#,
        ),
        (
            "/home/me/build/gst-docs/documentation/gst.html",
            "<p>gst</p>",
        ),
        (
            "/home/me/build/gst-docs/documentation/start.html",
            r#"<head></head><a href="/documentation/installing/index.html">installing</a>"#,
        ),
        (
            "/home/me/build/gst-docs/documentation/installing/index.html",
            r#"<head></head><a href="on-linux.html">linux</a><a href=/documentation/installing/on-mac.html>mac</a>"#,
        ),
        (
            "/home/me/build/gst-docs/documentation/installing/on-linux.html",
            "<p>linux</p>",
        ),
        (
            "/home/me/build/gst-docs/documentation/installing/on-mac.html",
            "<p>mac</p>",
        ),
        ("/home/me/build/gst-docs/assets/s.css", "body{}"),
        ("/home/me/secret.txt", "key"),
    ])
});
const SITE: &str = "/home/me/build/gst-docs/documentation/";
const SITE_DIR: &str = "/home/me/build/gst-docs/documentation";

struct TreeHosts;

impl RootHosts for TreeHosts {
    fn ssh_host(&self, _connection_id: &str) -> Option<String> {
        None
    }
    fn exists(&self, path: String) -> BoxFuture<bool> {
        let found = TREE.contains_key(path.as_str());
        Box::pin(async move { found })
    }
    fn run_remote(
        &self,
        _host: String,
        _script: String,
    ) -> BoxFuture<Result<ScriptOutput, String>> {
        Box::pin(async {
            Ok(ScriptOutput {
                code: 44,
                stdout: String::new(),
            })
        })
    }
}

/// The finder, its calls logged.
struct Logged {
    finder: Arc<dyn RootFinder>,
    finds: Log,
}

impl RootFinder for Logged {
    fn find_root(
        &self,
        connection_id: String,
        from: String,
        path: String,
    ) -> BoxFuture<Option<String>> {
        self.finds.lock().unwrap().push(format!("{from}|{path}"));
        self.finder.find_root(connection_id, from, path)
    }
}

struct Tree {
    pages: RenderedPages,
    reads: Log,
    finds: Log,
}

struct Opened {
    address: RenderedAddress,
    token: String,
}

impl Tree {
    fn new() -> Self {
        let reads = log();
        let finds = log();
        let seen = reads.clone();
        let finder = ConnectionRootFinder::new(
            Arc::new(TreeHosts),
            "/home/me",
            roamgate_exec::quote::shell_quote,
        );
        let pages = RenderedPages::new(
            reader(move |_, root, path| {
                seen.lock().unwrap().push(format!("{root}|{path}"));
                let at = format!("{}/{path}", root.trim_end_matches('/'));
                TREE.get(at.as_str())
                    .map(|text| octets(text))
                    .ok_or_else(|| ReadError::new("no such file"))
            }),
            shared(&clock()),
        )
        .with_root_finder(Arc::new(Logged {
            finder: Arc::new(finder),
            finds: finds.clone(),
        }));
        Self {
            pages,
            reads,
            finds,
        }
    }

    fn open_with(&self, root_of: &dyn Fn(&str) -> Option<SiteRootChoice>) -> Opened {
        let sites = strings(&[SITE]);
        let mut params = AddressParams::new(
            AddressTarget::Path("build/gst-docs/documentation/index.html"),
            "/home/me",
            &sites,
        );
        params.root_of = Some(root_of);
        let address = rendered_address(&params).unwrap();
        let token = self
            .pages
            .mint(
                MintParams::new("c1", address.mode, address.source.clone())
                    .home(address.home.clone()),
            )
            .unwrap();
        Opened { address, token }
    }

    fn open(&self) -> Opened {
        self.open_with(&|site| {
            self.pages.site_root("c1", site).map(|root| SiteRootChoice {
                root,
                explicit: false,
            })
        })
    }
}

fn token_in(location: &str) -> String {
    let rest = location.strip_prefix(RENDERED_PREFIX).unwrap();
    let token = &rest[..32];
    assert!(valid_token(token), "{location}");
    assert_eq!(&rest[32..33], "/");
    token.to_owned()
}

/// shared/renderedPage.ts pageFromHome.
fn page_from_home(url: &str, home: &str) -> String {
    let at = url.find(['?', '#']).unwrap_or(url.len());
    let (path, tail) = url.split_at(at);
    let mut home_parts: Vec<&str> = home.split('/').collect();
    home_parts.pop();
    let parts: Vec<&str> = path.split('/').collect();
    let mut common = 0;
    while common < home_parts.len()
        && common + 1 < parts.len()
        && parts[common] == home_parts[common]
    {
        common += 1;
    }
    format!(
        "{}{}{tail}",
        "../".repeat(home_parts.len() - common),
        parts[common..].join("/")
    )
}

/// shared/renderedPage.ts pageUnderHome.
fn page_under_home(page: &str, home: &str) -> Option<String> {
    let at = page.find(['?', '#']).unwrap_or(page.len());
    let (path, tail) = page.split_at(at);
    let mut parts: Vec<&str> = home.split('/').collect();
    parts.pop();
    let mut rest: Vec<&str> = path.split('/').collect();
    while rest.first() == Some(&"..") {
        parts.pop()?;
        rest.remove(0);
    }
    if rest.iter().any(|part| address::dot_part(part)) {
        return None;
    }
    parts.extend(rest);
    Some(format!("{}{tail}", parts.join("/")))
}

#[tokio::test]
async fn a_page_is_kept_from_the_frames_home_never_doubled_under_another_tokens_root() {
    let tree = Tree::new();
    // Opened before its root is known: served from the listed folder.
    let first = tree.open();
    assert_eq!(first.address.rest, "index.html");
    assert_eq!(first.address.home, None);
    let moved = get(
        &tree.pages,
        &format!(
            "/rendered/{}/.roamgate-root/documentation/libs.html",
            first.token
        ),
    )
    .await;
    let next = token_in(&hdr(&moved, "location").unwrap());
    // The root found above: the frame's home is the listed folder there.
    let libs = get_text(
        &tree.pages,
        &format!("/rendered/{next}/documentation/libs.html"),
    )
    .await;
    assert!(libs.contains("\"home\":\"documentation/\""));
    assert_eq!(
        page_from_home("documentation/libs.html", "documentation/"),
        "libs.html"
    );
    // Opened again: from the root found, the same home.
    let again = tree.open();
    assert_eq!(again.address.rest, "documentation/index.html");
    assert_eq!(again.address.home.as_deref(), Some("documentation/"));
    let page = get_text(
        &tree.pages,
        &format!("/rendered/{}/documentation/index.html", again.token),
    )
    .await;
    assert!(page.contains("\"home\":\"documentation/\""));
    // A server that forgot the root (restarted) serves the listed folder:
    // the page kept there is the listed folder's, not its path doubled.
    assert_eq!(
        page_under_home("index.html", "").as_deref(),
        Some("index.html")
    );
    assert_eq!(
        page_under_home("index.html", "documentation/").as_deref(),
        Some("documentation/index.html")
    );
    let fresh = Tree::new().open();
    assert!(matches!(
        fresh.address.source,
        RenderedSource::Files { walk: true, .. }
    ));
    assert_eq!(
        page_under_home(
            &page_from_home("documentation/index.html", "documentation/"),
            fresh.address.home.as_deref().unwrap_or("")
        )
        .as_deref(),
        Some("index.html")
    );
}

#[test]
fn a_files_home_is_its_directory_under_the_served_one_a_urls_under_the_site() {
    // The checkout served (scripts off), then its own folder (scripts on).
    let statically = rendered_address(&AddressParams::new(
        AddressTarget::Path("cancun/index.html"),
        "/trips/vacation",
        &[],
    ))
    .unwrap();
    assert_eq!(statically.rest, "cancun/index.html");
    assert_eq!(statically.home.as_deref(), Some("cancun/"));
    let sites = strings(&["/trips/vacation/cancun/"]);
    let listed = rendered_address(&AddressParams::new(
        AddressTarget::Path("cancun/index.html"),
        "/trips/vacation",
        &sites,
    ))
    .unwrap();
    assert_eq!(listed.rest, "index.html");
    assert_eq!(listed.home, None);
    // The page the checkout's token showed, under the listed folder's.
    assert_eq!(
        page_under_home(
            &page_from_home(&statically.rest, statically.home.as_deref().unwrap()),
            listed.home.as_deref().unwrap_or("")
        )
        .as_deref(),
        Some("index.html")
    );
    let sites = strings(&["http://h:8000/docs/"]);
    let url = rendered_address(&AddressParams::new(
        AddressTarget::Url(Some("http://h:8000/docs/a/page.html")),
        "/",
        &sites,
    ))
    .unwrap();
    assert_eq!(url.rest, "a/page.html");
    assert_eq!(url.home.as_deref(), Some("a/"));
}

#[tokio::test]
async fn is_found_above_the_listed_folder_from_a_root_absolute_link_then_kept() {
    let tree = Tree::new();
    let Opened { address, token } = tree.open();
    assert_eq!(address.source, files_source(SITE_DIR, Some(SITE), true));
    let page = get_text(&tree.pages, &format!("/rendered/{token}/index.html")).await;
    // Root-absolute links say they are, so a miss can look above.
    assert!(page.contains(&format!(
        "href=\"/rendered/{token}/.roamgate-root/documentation/libs.html\""
    )));
    let moved = get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/documentation/libs.html?x=1"),
    )
    .await;
    assert_eq!(moved.status(), 307);
    let location = hdr(&moved, "location").unwrap();
    let next = token_in(&location);
    assert_eq!(
        location,
        format!("/rendered/{next}/documentation/libs.html?x=1")
    );
    assert_ne!(next, token);
    assert_eq!(
        logged(&tree.finds),
        vec![format!("{SITE_DIR}|documentation/libs.html")]
    );
    assert_eq!(
        tree.pages.site_root("c1", SITE).as_deref(),
        Some("/home/me/build/gst-docs")
    );
    assert_eq!(tree.pages.site_root("c2", SITE), None);
    // Its relative links work from there, and nothing marks them.
    let libs = get(
        &tree.pages,
        &format!("/rendered/{next}/documentation/libs.html"),
    )
    .await;
    assert_eq!(libs.status(), 200);
    assert!(
        get_text(
            &tree.pages,
            &format!("/rendered/{next}/documentation/gst.html")
        )
        .await
        .contains("gst")
    );
    assert_eq!(
        get_text(&tree.pages, &format!("/rendered/{next}/assets/s.css")).await,
        "body{}"
    );
    // The next opening starts at the root found: no looking again.
    let again = tree.open();
    assert_eq!(
        again.address.source,
        files_source("/home/me/build/gst-docs", Some(SITE), false)
    );
    assert_eq!(again.address.rest, "documentation/index.html");
    let other = get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/assets/s.css"),
    )
    .await;
    // A style sheet is served from the root at once, not redirected.
    assert_eq!(other.status(), 200);
    assert!(hdr(&other, "content-type").unwrap().starts_with("text/css"));
    assert_eq!(hdr(&other, "location"), None);
    assert_eq!(text(other).await, "body{}");
    assert_eq!(logged(&tree.finds).len(), 1);
}

#[tokio::test]
async fn a_root_absolute_style_sheet_above_the_folder_is_served_a_page_redirects() {
    let tree = Tree::new();
    let Opened { token, .. } = tree.open();
    let css = get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/assets/s.css"),
    )
    .await;
    assert_eq!(css.status(), 200);
    assert!(hdr(&css, "content-type").unwrap().starts_with("text/css"));
    assert_eq!(hdr(&css, "location"), None);
    assert_eq!(text(css).await, "body{}");
    let page = get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/documentation/libs.html"),
    )
    .await;
    assert_eq!(page.status(), 307);
    let location = hdr(&page, "location").unwrap();
    let next = token_in(&location);
    assert_eq!(
        location,
        format!("/rendered/{next}/documentation/libs.html")
    );
}

#[tokio::test]
async fn clicking_through_the_site_stays_under_a_token_never_roamgates_root() {
    let tree = Tree::new();
    let Opened { token, .. } = tree.open();
    // index -> /documentation/installing/index.html, as written by the server.
    let start = get_text(&tree.pages, &format!("/rendered/{token}/start.html")).await;
    let link = format!("/rendered/{token}/.roamgate-root/documentation/installing/index.html");
    assert!(start.contains(&format!("href=\"{link}\"")));
    // Its script sends what it builds the same way.
    assert!(start.contains(&format!(
        "{{\"base\":\"/\",\"to\":\"/rendered/{token}/.roamgate-root/\"}}"
    )));
    let moved = get(&tree.pages, &link).await;
    assert_eq!(moved.status(), 307);
    let location = hdr(&moved, "location").unwrap();
    let next = token_in(&location);
    assert_eq!(
        location,
        format!("/rendered/{next}/documentation/installing/index.html")
    );
    let installing = get(&tree.pages, &location).await;
    assert_eq!(installing.status(), 200);
    let html = text(installing).await;
    // After the root's redirect: its root-absolute links are under the
    // new token's root, plainly, and so is what its script builds.
    assert!(html.contains(&format!(
        "href=\"/rendered/{next}/documentation/installing/on-mac.html\""
    )));
    assert!(html.contains(&format!(
        "{{\"base\":\"/\",\"to\":\"/rendered/{next}/\",\"home\":\"documentation/\"}}"
    )));
    assert!(
        get_text(
            &tree.pages,
            &format!("/rendered/{next}/documentation/installing/on-mac.html")
        )
        .await
        .ends_with("<p>mac</p>")
    );
    // A relative link resolves under the same token.
    let relative = url::Url::parse(&format!("https://x{location}"))
        .unwrap()
        .join("on-linux.html")
        .unwrap()
        .path()
        .to_owned();
    assert_eq!(
        relative,
        format!("/rendered/{next}/documentation/installing/on-linux.html")
    );
    assert!(
        get_text(&tree.pages, &relative)
            .await
            .ends_with("<p>linux</p>")
    );
}

#[tokio::test]
async fn a_frames_request_off_its_token_gets_a_page_saying_so_never_the_login_page() {
    let frame = [
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-dest", "iframe"),
        ("sec-fetch-mode", "navigate"),
    ];
    let at = |path: &str, headers: &[(&str, &str)]| rendered_stray(path, &header_map(headers));
    let stray = at("/documentation/installing/on-linux.html?a=<b>", &frame).unwrap();
    assert_eq!(stray.status(), 404);
    let csp = hdr(&stray, "content-security-policy").unwrap();
    assert!(csp.contains("sandbox allow-scripts"));
    assert!(!csp.contains("allow-same-origin"));
    assert!(
        hdr(&stray, "content-type")
            .unwrap()
            .starts_with("text/html")
    );
    let page = text(stray).await;
    assert!(page.contains("not part of this site"));
    assert!(!page.contains("<b>"));
    let lower = page.to_lowercase();
    assert!(!lower.contains("password") && !lower.contains("login"));
    // It hands the path to the parent, which knows the token.
    assert!(page.contains("type:\"stray\""));
    // A fetch from the page's opaque origin: not found.
    let fetched = at(
        "/api/health",
        &[
            ("sec-fetch-site", "cross-site"),
            ("sec-fetch-dest", "empty"),
            ("origin", "null"),
        ],
    )
    .unwrap();
    assert_eq!(fetched.status(), 404);
    assert!(text(fetched).await.contains("not part of this site"));
    // Roamgate's own requests, a link to Roamgate from elsewhere, and the
    // pages themselves go on to the gate or the pages.
    assert!(at("/login", &[]).is_none());
    assert!(
        at(
            "/",
            &[
                ("sec-fetch-site", "same-origin"),
                ("sec-fetch-dest", "iframe")
            ]
        )
        .is_none()
    );
    assert!(
        at(
            "/",
            &[
                ("sec-fetch-site", "cross-site"),
                ("sec-fetch-dest", "document")
            ]
        )
        .is_none()
    );
    assert!(at("/rendered/x/a.html", &frame).is_none());
}

#[tokio::test]
async fn a_root_absolute_link_found_in_the_folder_itself_stays_there() {
    let tree = Tree::new();
    let Opened { token, .. } = tree.open();
    let page = get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/gst.html"),
    )
    .await;
    // A page: at its plain address under the same token.
    assert_eq!(page.status(), 307);
    assert_eq!(
        hdr(&page, "location"),
        Some(format!("/rendered/{token}/gst.html"))
    );
    assert!(logged(&tree.finds).is_empty());
}

#[tokio::test]
async fn an_explicit_root_wins_and_nothing_is_looked_for() {
    let tree = Tree::new();
    let Opened { address, token } = tree.open_with(&|_| {
        Some(SiteRootChoice {
            root: "/home/me/build/gst-docs/".into(),
            explicit: true,
        })
    });
    assert_eq!(
        address.source,
        files_source("/home/me/build/gst-docs", Some(SITE), false)
    );
    assert_eq!(address.rest, "documentation/index.html");
    let page = get_text(
        &tree.pages,
        &format!("/rendered/{token}/documentation/index.html"),
    )
    .await;
    assert!(page.contains(&format!(
        "href=\"/rendered/{token}/documentation/libs.html\""
    )));
    assert_eq!(
        get(
            &tree.pages,
            &format!("/rendered/{token}/documentation/missing.html")
        )
        .await
        .status(),
        404
    );
    assert!(logged(&tree.finds).is_empty());
    // A root that does not contain the site is not one.
    let ignored = tree.open_with(&|_| {
        Some(SiteRootChoice {
            root: "/elsewhere/".into(),
            explicit: true,
        })
    });
    assert_eq!(
        ignored.address.source,
        files_source(SITE_DIR, Some(SITE), true)
    );
}

#[tokio::test]
async fn never_escapes_no_step_up_nothing_at_or_above_home_not_twice_above() {
    let tree = Tree::new();
    let Opened { token, .. } = tree.open();
    for path in [
        ".roamgate-root/../secret.txt",
        ".roamgate-root/%2e%2e/secret.txt",
        ".roamgate-root/a/..%2f..%2fsecret.txt",
        ".roamgate-root/..%2f..%2f..%2fsecret.txt",
    ] {
        let response = get(&tree.pages, &format!("/rendered/{token}/{path}")).await;
        assert!([400, 404].contains(&response.status().as_u16()), "{path}");
    }
    assert!(logged(&tree.finds).is_empty());
    let read_home = || {
        logged(&tree.reads)
            .iter()
            .any(|read| read.starts_with("/home/me|"))
    };
    assert!(!read_home());
    // secret.txt is in home: home is never a site's root.
    assert_eq!(
        get(
            &tree.pages,
            &format!("/rendered/{token}/.roamgate-root/secret.txt")
        )
        .await
        .status(),
        404
    );
    assert_eq!(logged(&tree.finds), vec![format!("{SITE_DIR}|secret.txt")]);
    // Missed once: not looked for again for a while.
    get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/secret.txt"),
    )
    .await;
    assert_eq!(logged(&tree.finds).len(), 1);
    // Once a root is found, nothing above it is looked for or served.
    get(
        &tree.pages,
        &format!("/rendered/{token}/.roamgate-root/documentation/libs.html"),
    )
    .await;
    assert_eq!(
        tree.pages.site_root("c1", SITE).as_deref(),
        Some("/home/me/build/gst-docs")
    );
    let Opened { token: rooted, .. } = tree.open();
    let page = get_text(
        &tree.pages,
        &format!("/rendered/{rooted}/documentation/index.html"),
    )
    .await;
    assert!(!page.contains(".roamgate-root"));
    assert_eq!(
        get(&tree.pages, &format!("/rendered/{rooted}/..%2fsecret.txt"))
            .await
            .status(),
        400
    );
    assert!(!read_home());
}

struct Elsewhere;

impl RootFinder for Elsewhere {
    fn find_root(&self, _: String, _: String, _: String) -> BoxFuture<Option<String>> {
        Box::pin(async { Some("/elsewhere".to_owned()) })
    }
}

#[tokio::test]
async fn a_finders_answer_that_is_not_above_the_folder_is_refused() {
    let pages = RenderedPages::new(
        reader(|_, _, _| Err(ReadError::new("no such file"))),
        shared(&clock()),
    )
    .with_root_finder(Arc::new(Elsewhere));
    let token = pages
        .mint(MintParams::new(
            "c1",
            RenderedMode::Site,
            files_source("/a/b/c", Some("/a/b/c/"), true),
        ))
        .unwrap();
    assert_eq!(
        get(&pages, &format!("/rendered/{token}/.roamgate-root/x.html"))
            .await
            .status(),
        404
    );
    assert_eq!(pages.site_root("c1", "/a/b/c/"), None);
}

#[test]
fn candidates_stop_below_home_and_the_filesystems_root() {
    assert_eq!(
        site_root_candidates("/home/me/a/b/c", "/home/me"),
        strings(&["/home/me/a/b", "/home/me/a"])
    );
    assert_eq!(
        site_root_candidates("/srv/www/docs/", "/home/me"),
        strings(&["/srv/www", "/srv"])
    );
    assert_eq!(
        site_root_candidates(&format!("/x{}", "/d".repeat(20)), "/home/me").len(),
        SITE_ROOT_MAX_LEVELS
    );
}

#[cfg(unix)]
#[test]
fn the_hosts_script_tries_the_same_directories() {
    let temp = tempfile::Builder::new()
        .prefix("rg-site-root-")
        .tempdir()
        .unwrap();
    let dir = temp.path().to_str().unwrap().to_owned();
    std::fs::create_dir_all(format!("{dir}/home/site/docs/deep")).unwrap();
    std::fs::create_dir_all(format!("{dir}/home/site/assets")).unwrap();
    std::fs::write(format!("{dir}/home/site/assets/a.css"), "").unwrap();
    std::fs::write(format!("{dir}/home/top.css"), "").unwrap();
    let run = |path: &str| {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(site_root_script(
                &format!("{dir}/home/site/docs/deep/"),
                path,
                &roamgate_exec::quote::shell_quote,
            ))
            .env_clear()
            .env("HOME", format!("{dir}/home"))
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .output()
            .unwrap()
    };
    let found = run("assets/a.css");
    assert_eq!(found.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(found.stdout).unwrap(),
        format!("{dir}/home/site\n")
    );
    // At home: never.
    assert_eq!(run("top.css").status.code(), Some(44));
    assert_eq!(run("nowhere.css").status.code(), Some(44));
}

// a listed site's localStorage

const PAGE: &str = "<!doctype html><html><head><title>t</title></head><body>x</body></html>";

fn page_reader() -> Arc<dyn PageReader> {
    reader(|_, _, _| Ok(file_of(PAGE, "text/html")))
}

fn storage_pages(storage: Arc<SiteStorage>) -> RenderedPages {
    RenderedPages::new(page_reader(), shared(&clock())).with_storage(storage)
}

fn mint_site_files(pages: &RenderedPages, mode: RenderedMode, site: Option<&str>) -> String {
    pages
        .mint(MintParams::new(
            "c",
            mode,
            files_source("/site", site, false),
        ))
        .unwrap()
}

async fn page_of(pages: &RenderedPages, token: &str) -> String {
    get_text(pages, &format!("/rendered/{token}/")).await
}

fn set(key: &str, value: &str) -> StorageWrite {
    StorageWrite::Set {
        key: key.to_owned(),
        value: value.to_owned(),
    }
}

fn items(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

#[tokio::test]
async fn is_written_into_the_pages_of_the_listed_site_with_its_own_items_only() {
    let storage = SiteStorage::in_memory();
    let pages = storage_pages(storage.clone());
    storage.write("/site/", &set("pref-theme", "dark")).unwrap();
    storage.write("/other/", &set("secret", "nope")).unwrap();
    let text = page_of(
        &pages,
        &mint_site_files(&pages, RenderedMode::Site, Some("/site/")),
    )
    .await;
    assert!(text.contains("{\"pref-theme\":\"dark\"}"));
    assert!(!text.contains("secret"));
    assert!(!text.contains("nope"));
}

#[tokio::test]
async fn is_not_given_to_a_static_page_a_page_with_scripts_on_once_or_without_storage() {
    let storage = SiteStorage::in_memory();
    let pages = storage_pages(storage.clone());
    storage.write("/site/", &set("k", "VALUE")).unwrap();
    let stat = page_of(
        &pages,
        &mint_site_files(&pages, RenderedMode::Static, Some("/site/")),
    )
    .await;
    assert!(!stat.contains("VALUE"));
    // Scripts turned on for a file, its directory not listed: no site.
    let once = page_of(&pages, &mint_site_files(&pages, RenderedMode::Site, None)).await;
    assert!(!once.contains("VALUE"));
    assert!(once.contains(", null);})();"));
    let plain = RenderedPages::new(page_reader(), shared(&clock()));
    let token = mint_site_files(&plain, RenderedMode::Site, Some("/site/"));
    assert!(!page_of(&plain, &token).await.contains("VALUE"));
}

#[tokio::test]
async fn a_value_cannot_close_the_script() {
    let storage = SiteStorage::in_memory();
    let pages = storage_pages(storage.clone());
    let evil = "</script><script>alert(1)</script>\u{2028}<!--";
    storage.write("/site/", &set("</script>", evil)).unwrap();
    let text = page_of(
        &pages,
        &mint_site_files(&pages, RenderedMode::Site, Some("/site/")),
    )
    .await;
    assert_eq!(text.matches("</script>").count(), 1);
    assert!(!text.contains("alert(1)</script>"));
    assert!(!text.contains('\u{2028}'));
    assert!(text.contains("\\u003c/script>"));
}

#[tokio::test]
async fn a_url_site_is_keyed_by_its_listed_entry() {
    let storage = SiteStorage::in_memory();
    storage.write("http://blog.test/", &set("a", "b")).unwrap();
    let pages = RenderedPages::new(
        reader(|_, _, _| Err(ReadError::new("no files"))),
        shared(&clock()),
    )
    .with_storage(storage)
    .with_fetch(Arc::new(Site {
        answer: Box::new(|_| answer(200, &[("content-type", "text/html")], PAGE)),
        calls: Arc::new(Mutex::new(Vec::new())),
    }));
    let token = pages
        .mint(MintParams::new(
            "c",
            RenderedMode::Site,
            url_source("http://blog.test/", Some("http://blog.test/")),
        ))
        .unwrap();
    assert!(page_of(&pages, &token).await.contains("{\"a\":\"b\"}"));
}

#[test]
fn writes_go_to_the_tokens_site_only_from_its_connection() {
    let storage = SiteStorage::in_memory();
    let pages = storage_pages(storage.clone());
    let token = mint_site_files(&pages, RenderedMode::Site, Some("/site/"));
    assert_eq!(pages.write_storage("c", &token, &set("k", "v")), Ok(true));
    assert_eq!(storage.get("/site/"), items(&[("k", "v")]));
    assert_eq!(storage.get("/other/"), items(&[]));
    // Another connection, an unknown token, a static or unlisted page.
    assert_eq!(pages.write_storage("d", &token, &set("x", "y")), Ok(false));
    assert_eq!(
        pages.write_storage("c", &"0".repeat(32), &set("x", "y")),
        Ok(false)
    );
    let stat = mint_site_files(&pages, RenderedMode::Static, Some("/site/"));
    assert_eq!(pages.write_storage("c", &stat, &set("x", "y")), Ok(false));
    let unlisted = mint_site_files(&pages, RenderedMode::Site, None);
    assert_eq!(
        pages.write_storage("c", &unlisted, &set("x", "y")),
        Ok(false)
    );
    let remove = StorageWrite::Remove {
        key: "k".to_owned(),
    };
    pages.write_storage("c", &token, &remove).unwrap();
    assert_eq!(storage.get("/site/"), items(&[]));
}

#[test]
fn is_bounded_too_many_keys_too_many_characters() {
    let storage = SiteStorage::in_memory();
    for index in 0..RENDERED_STORAGE_MAX_KEYS {
        storage
            .write("/s/", &set(&format!("k{index}"), "v"))
            .unwrap();
    }
    assert_eq!(
        storage.write("/s/", &set("more", "v")),
        Err(StorageQuotaError)
    );
    assert_eq!(StorageQuotaError.to_string(), "the site's storage is full");
    assert_eq!(StorageQuotaError::NAME, "QuotaExceededError");
    // An existing key can still change, and room comes back with a removal.
    storage.write("/s/", &set("k0", "w")).unwrap();
    let remove = StorageWrite::Remove {
        key: "k1".to_owned(),
    };
    storage.write("/s/", &remove).unwrap();
    storage.write("/s/", &set("more", "v")).unwrap();
    let big = SiteStorage::in_memory();
    big.write(
        "/s/",
        &set("a", &"x".repeat(RENDERED_STORAGE_MAX_CHARS - 10)),
    )
    .unwrap();
    assert_eq!(
        big.write("/s/", &set("b", &"y".repeat(20))),
        Err(StorageQuotaError)
    );
    big.clear("/s/");
    assert_eq!(big.get("/s/"), items(&[]));
}

#[tokio::test]
async fn survives_a_restart() {
    let temp = tempfile::Builder::new()
        .prefix("rg-rstore-")
        .tempdir()
        .unwrap();
    let file = rendered_storage_path(temp.path());
    let context = roamgate_base::paths::DataContext::new(
        temp.path(),
        roamgate_base::paths::Platform::Unix,
        None,
    );
    let first = SiteStorage::open(context.clone(), file.clone());
    first.write("/s/", &set("pref-theme", "dark")).unwrap();
    first.flush().await;
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\"/s/\":{\"pref-theme\":\"dark\"}}\n"
    );
    assert_eq!(
        SiteStorage::open(context, file).get("/s/"),
        items(&[("pref-theme", "dark")])
    );
}
