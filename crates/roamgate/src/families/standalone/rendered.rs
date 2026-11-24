//! Rendered reviews' pages (index.ts `renderedPages`, `renderedStorage`
//! and `reviewRpcConnection`'s rendered members): the tokens of the
//! sandboxed frames and their pages under `/rendered/<token>/`, served
//! before the authentication gate (the token is their credential), the
//! files read on the connection's host, the listed sites' roots found
//! there, a site fetched over HTTP, and the sites' `localStorage`.

use std::io;
use std::sync::{Arc, OnceLock};

use bytes::Bytes;
use futures_util::StreamExt as _;
use roamgate_base::clock::BoxFuture;
use roamgate_exec::quote::shell_quote;
use roamgate_git::GitContext;
use roamgate_http::rendered_pages::{
    AddressParams, AddressTarget, ConnectionFileReader, ConnectionRootFinder, FileCacheConfig,
    FileHosts, MintParams, PageBody, PageRequest, RENDERED_BODY_MAX_BYTES, RENDERED_PREFIX,
    ReadError, RenderedFile, RenderedMode, RenderedPages, RenderedSource, RootHosts, ScriptOutput,
    SiteFetch, SiteRequest, SiteResponse, SiteRootChoice, SiteStorage, StorageWrite,
    rendered_address, rendered_storage_path, rendered_svg_page,
};
use roamgate_sidecar::family::FamilyContext;
use roamgate_sidecar::peer::{BodyReceiver, HttpRequest, HttpResponse};
use roamgate_sidecar::protocol::RpcError;
use roamgate_workspace::file_download::FileDownloadOptions;
use roamgate_workspace::file_types::{FileBody, FileDownloadResult};
use roamgate_workspace::local_files::{DownloadFailure, download_local_file};
use roamgate_workspace::remote_files::download_remote_file;
use serde_json::{Value, json};

use super::Layer;

/// `ReviewError(message, status)` as the channel carries it.
fn status_error(message: impl Into<String>, status: u16) -> RpcError {
    let mut error = RpcError::new(message);
    error.data = Some(json!({"status": status}));
    error
}

fn mode_name(mode: RenderedMode) -> &'static str {
    match mode {
        RenderedMode::Static => "static",
        RenderedMode::Site => "site",
    }
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

/// A connection's SSH destination, when it is ready.
fn ssh_host(layer: &Layer, connection_id: &str) -> Option<String> {
    layer
        .ready(connection_id)
        .ok()
        .flatten()
        .and_then(|lease| lease.runtime.ssh_host().map(str::to_owned))
}

/// What the pages' reader and root finder need of the server.
struct Hosts {
    layer: Arc<Layer>,
}

/// The bytes of `[at, end)` of a file of this machine, read as sent.
fn file_stream(path: std::path::PathBuf, start: u64, end: u64) -> PageBody {
    let state = (path, start, end, None::<tokio::fs::File>);
    PageBody::stream(futures_util::stream::unfold(
        state,
        |(path, at, end, file)| async move {
            use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
            if at >= end {
                return None;
            }
            let mut file = match file {
                Some(file) => file,
                None => {
                    let mut file = match tokio::fs::File::open(&path).await {
                        Ok(file) => file,
                        Err(error) => return Some((Err(error), (path, end, end, None))),
                    };
                    if let Err(error) = file.seek(io::SeekFrom::Start(at)).await {
                        return Some((Err(error), (path, end, end, None)));
                    }
                    file
                }
            };
            let mut chunk = vec![0; (end - at).min(64 * 1024) as usize];
            match file.read(&mut chunk).await {
                Ok(0) => None,
                Ok(read) => {
                    chunk.truncate(read);
                    let next = (path, at + read as u64, end, Some(file));
                    Some((Ok(Bytes::from(chunk)), next))
                }
                Err(error) => Some((Err(error), (path, end, end, None))),
            }
        },
    ))
}

/// A download as a page's file.
fn page_file(
    download: Result<FileDownloadResult, DownloadFailure>,
) -> Result<RenderedFile, ReadError> {
    let download = download.map_err(|failure| match failure {
        DownloadFailure::Refused(refused) if refused.status == 413 => {
            ReadError::too_large(refused.message)
        }
        DownloadFailure::Refused(refused) => ReadError::new(refused.message),
        DownloadFailure::Failed(error) => ReadError::new(error.message),
    })?;
    let body = match download.body {
        FileBody::Bytes(bytes) => PageBody::Full(Bytes::from(bytes)),
        FileBody::File { path, start, end } => file_stream(path, start, end),
        FileBody::Stream(chunks) => PageBody::stream(futures_util::stream::unfold(
            chunks,
            |mut chunks| async move {
                let chunk = chunks.recv().await?;
                Some((chunk.map(Bytes::from).map_err(io::Error::other), chunks))
            },
        )),
    };
    Ok(RenderedFile {
        body,
        size: download.size,
        content_type: download.content_type,
    })
}

impl FileHosts for Hosts {
    fn ssh_host(&self, connection_id: &str) -> Option<String> {
        ssh_host(&self.layer, connection_id)
    }

    fn read_local(&self, root: String, path: String) -> BoxFuture<Result<RenderedFile, ReadError>> {
        Box::pin(async move {
            page_file(download_local_file(&root, &path, &FileDownloadOptions::default()).await)
        })
    }

    fn read_remote(
        &self,
        host: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>> {
        let layer = self.layer.clone();
        Box::pin(async move {
            // Read whole over SSH: refused above this before any byte comes.
            let options = FileDownloadOptions {
                max_bytes: Some(RENDERED_BODY_MAX_BYTES),
                ..FileDownloadOptions::default()
            };
            let git = ssh_git(&layer, &host);
            page_file(download_remote_file(&git, &host, &root, &path, &options, None).await)
        })
    }
}

/// A git context over `host` through the core's SSH slots: the one of a
/// ready connection on it.
fn ssh_git(layer: &Layer, host: &str) -> GitContext {
    let found = layer.host.manager_now().and_then(|manager| {
        manager.list().into_iter().find_map(|status| {
            let lease = manager.ready_runtime_lease(&status.id).ok().flatten()?;
            (lease.runtime.ssh_host() == Some(host))
                .then(|| super::super::workspace::ranger_runtime(&status.id))
                .flatten()
                .map(|runtime| runtime.git().clone())
        })
    });
    found.unwrap_or_else(|| {
        GitContext::new(
            Some(host.to_owned()),
            Arc::new(roamgate_git::exec::LocalRunner::system()),
        )
    })
}

impl RootHosts for Hosts {
    fn ssh_host(&self, connection_id: &str) -> Option<String> {
        ssh_host(&self.layer, connection_id)
    }

    fn exists(&self, path: String) -> BoxFuture<bool> {
        Box::pin(async move { tokio::fs::metadata(&path).await.is_ok() })
    }

    fn run_remote(&self, host: String, script: String) -> BoxFuture<Result<ScriptOutput, String>> {
        let layer = self.layer.clone();
        Box::pin(async move {
            let ran = super::connections::run_ssh(
                &layer,
                &host,
                &format!("sh -c {}", shell_quote(&script)),
                super::connections::SshRun {
                    read: true,
                    tag: "rendered.root",
                    connection: None,
                    stdin: None,
                    timeout_ms: 15_000,
                    lane: roamgate_exec::lanes::current_lane(),
                },
            )
            .await?;
            Ok(ScriptOutput {
                code: ran.code,
                stdout: String::from_utf8_lossy(&ran.stdout).into_owned(),
            })
        })
    }
}

/// A site fetched as Bun's `fetch` did: no redirect followed, given up
/// after the request's timeout.
struct Fetch {
    client: reqwest::Client,
}

impl SiteFetch for Fetch {
    fn fetch(&self, request: SiteRequest) -> BoxFuture<Result<SiteResponse, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|error| error.to_string())?;
            let mut asked = client
                .request(method, &request.url)
                .timeout(request.timeout);
            for (name, value) in &request.headers {
                asked = asked.header(name, value);
            }
            if let Some(body) = request.body {
                asked = asked.body(body);
            }
            let response = asked.send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let headers = response.headers().clone();
            let body = PageBody::stream(futures_util::stream::unfold(
                response,
                |mut response| async move {
                    match response.chunk().await {
                        Ok(Some(chunk)) => Some((Ok(chunk), response)),
                        Ok(None) => None,
                        Err(error) => Some((Err(io::Error::other(error)), response)),
                    }
                },
            ));
            Ok(SiteResponse {
                status,
                headers,
                body,
            })
        })
    }
}

struct Rendered {
    pages: RenderedPages,
    storage: Arc<SiteStorage>,
}

/// The server's pages and their storage, made at first use.
fn rendered(layer: &Arc<Layer>) -> &'static Rendered {
    static RENDERED: OnceLock<Rendered> = OnceLock::new();
    RENDERED.get_or_init(|| {
        let env = roamgate_base::env::ProcessEnv;
        let context = roamgate_base::paths::DataContext::from_env(&env);
        let file = rendered_storage_path(&context.data_root());
        let storage = SiteStorage::open(context, file);
        let hosts = Arc::new(Hosts {
            layer: layer.clone(),
        });
        let reader = ConnectionFileReader::new(
            hosts.clone(),
            layer.clock.clone(),
            FileCacheConfig::default(),
        );
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        let pages = RenderedPages::new(Arc::new(reader), layer.clock.clone())
            .with_root_finder(Arc::new(ConnectionRootFinder::new(
                hosts,
                home(),
                shell_quote,
            )))
            .with_fetch(Arc::new(Fetch { client }))
            .with_storage(storage.clone());
        Rendered { pages, storage }
    })
}

/// `review.connection`'s rendered ops for connection `id`.
pub(super) async fn connection_op(
    layer: &Arc<Layer>,
    cx: &FamilyContext,
    id: &str,
    op: &str,
    args: &Value,
) -> Result<Value, RpcError> {
    let rendered = rendered(layer);
    let text = |key: &str| args[key].as_str().unwrap_or("").to_owned();
    match op {
        "renderedSvg" => {
            let mode = if args["scripts"] == true {
                RenderedMode::Site
            } else {
                RenderedMode::Static
            };
            let body = rendered_svg_page(&text("svg"), args["color"].as_str());
            let token = rendered
                .pages
                .mint(MintParams::new(id, mode, RenderedSource::Inline { body }))
                .map_err(RpcError::new)?;
            Ok(json!({"src": format!("{RENDERED_PREFIX}{token}/"), "mode": mode_name(mode)}))
        }
        "renderedPage" => {
            let target = &args["target"];
            if target["kind"] != "rendered" {
                return Err(status_error("not a rendered review", 400));
            }
            let settings = super::super::settings::read_shared(cx).await;
            let map = settings.as_map();
            let sites: Vec<String> = map
                .get("rendered_sites")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|site| site.as_str().map(str::to_owned))
                .collect();
            let roots = map
                .get("rendered_site_roots")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let root = text("root");
            let address_target = match target.get("path").and_then(Value::as_str) {
                Some(path) => AddressTarget::Path(path),
                None => AddressTarget::Url(target.get("url").and_then(Value::as_str)),
            };
            // The root set in Settings wins over the one found.
            let root_of = |site: &str| -> Option<SiteRootChoice> {
                if let Some(explicit) = roots
                    .get(site)
                    .and_then(Value::as_str)
                    .filter(|root| !root.is_empty())
                {
                    return Some(SiteRootChoice {
                        root: explicit.to_owned(),
                        explicit: true,
                    });
                }
                rendered
                    .pages
                    .site_root(id, site)
                    .map(|root| SiteRootChoice {
                        root,
                        explicit: false,
                    })
            };
            let address = rendered_address(&AddressParams {
                target: address_target,
                root: &root,
                sites: &sites,
                page: args["page"].as_str(),
                scripts: args["scripts"] == true,
                root_of: Some(&root_of),
            })
            .map_err(|message| status_error(message, 400))?;
            let token = rendered
                .pages
                .mint(MintParams::new(id, address.mode, address.source).home(address.home))
                .map_err(RpcError::new)?;
            let mut out = json!({
                "src": format!("{RENDERED_PREFIX}{token}/{}", address.rest),
                "mode": mode_name(address.mode),
            });
            if let Some(site) = address.site {
                out["site"] = json!(site);
            }
            Ok(out)
        }
        "renderedStorage" => {
            let write = storage_write(args.get("write"))
                .ok_or_else(|| status_error("invalid storage write", 400))?;
            match rendered.pages.write_storage(id, &text("token"), &write) {
                Ok(written) => Ok(json!(written)),
                Err(_) => Err(RpcError::with_code("the site's storage is full", "quota")),
            }
        }
        "clearRenderedStorage" => {
            rendered.storage.clear(&text("site"));
            Ok(json!({}))
        }
        other => Err(RpcError::new(format!(
            "unknown review connection op {other}"
        ))),
    }
}

/// `parseStorageWrite`: a page's write, or None when it is not one.
fn storage_write(raw: Option<&Value>) -> Option<StorageWrite> {
    let parsed = roamgate_review::rpc::parse_storage_write(raw)?;
    match parsed["op"].as_str()? {
        "clear" => Some(StorageWrite::Clear),
        "remove" => Some(StorageWrite::Remove {
            key: parsed["key"].as_str()?.to_owned(),
        }),
        "set" => Some(StorageWrite::Set {
            key: parsed["key"].as_str()?.to_owned(),
            value: parsed["value"].as_str()?.to_owned(),
        }),
        _ => None,
    }
}

/// The path and query of a request's URL, as sent.
fn target_of(url: &str) -> &str {
    match url.find("://") {
        Some(scheme) => {
            let after = &url[scheme + 3..];
            after.find('/').map_or("/", |at| &after[at..])
        }
        None => url,
    }
}

/// A `/rendered/` request: its page, or None for any other path.
pub(crate) async fn http(
    layer: &Arc<Layer>,
    request: &HttpRequest,
    body: Option<BodyReceiver>,
) -> Option<HttpResponse> {
    let target = target_of(&request.url);
    if !target.starts_with(RENDERED_PREFIX) {
        return None;
    }
    let headers = header_map(request);
    let body = body.map(|receiver| {
        futures_util::stream::unfold(receiver, |mut receiver| async move {
            let chunk = receiver.chunk().await?;
            Some((Ok::<_, io::Error>(Bytes::from(chunk)), receiver))
        })
        .boxed()
    });
    let response = rendered(layer)
        .pages
        .handle(
            PageRequest {
                method: &request.method,
                target,
                headers: &headers,
            },
            body,
        )
        .await?;
    Some(page_response(response))
}

fn header_map(request: &HttpRequest) -> http::HeaderMap {
    let mut headers = http::HeaderMap::new();
    for (name, value) in &request.headers {
        if let (Ok(name), Ok(value)) = (
            http::HeaderName::from_bytes(name.as_bytes()),
            http::HeaderValue::from_str(value),
        ) {
            headers.append(name, value);
        }
    }
    headers
}

/// A page's response as the channel sends it, its body as it comes.
fn page_response(response: roamgate_http::rendered_pages::PageResponse) -> HttpResponse {
    let (parts, body) = response.into_parts();
    let headers = parts
        .headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_owned(), value.to_owned()))
        })
        .collect();
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    tokio::spawn(async move {
        match body {
            PageBody::Empty => {}
            PageBody::Full(bytes) => {
                let _ = tx.send(bytes.to_vec()).await;
            }
            PageBody::Stream(mut stream) => {
                while let Some(Ok(chunk)) = stream.next().await {
                    if tx.send(chunk.to_vec()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    HttpResponse {
        status: parts.status.as_u16(),
        headers,
        body: Some(rx),
    }
}

/// A rendered page's frame off its token (`renderedStray`): never the
/// login page, nor anything behind the gate. None for any other request.
pub(crate) fn stray(request: &HttpRequest) -> Option<HttpResponse> {
    roamgate_http::rendered_pages::rendered_stray(target_of(&request.url), &header_map(request))
        .map(page_response)
}
