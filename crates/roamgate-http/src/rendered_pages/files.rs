//! The pages' files: a body as read (whole or streamed), the seams the
//! host fills (a connection's host and its reads, a site's root looked
//! for there), the reader of every connection with its short cache of
//! files read over SSH (connectionFileReader), and the site root finder
//! (connectionRootFinder, siteRootCandidates, siteRootScript).

use std::io;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use bytes::{Bytes, BytesMut};
use futures_util::stream::BoxStream;
use futures_util::{Stream, StreamExt};
use roamgate_base::assets::{SITE_ROOT_SH, TemplateValue, fill_template};
use roamgate_base::clock::{BoxFuture, SharedClock};

use super::js;
use super::page_path;

/// A body: none, whole, or streamed (a file or a site's response).
pub enum PageBody {
    Empty,
    Full(Bytes),
    Stream(BoxStream<'static, io::Result<Bytes>>),
}

impl std::fmt::Debug for PageBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => f.write_str("Empty"),
            Self::Full(bytes) => write!(f, "Full({} bytes)", bytes.len()),
            Self::Stream(_) => f.write_str("Stream"),
        }
    }
}

impl From<Bytes> for PageBody {
    fn from(bytes: Bytes) -> Self {
        Self::Full(bytes)
    }
}

impl From<String> for PageBody {
    fn from(text: String) -> Self {
        Self::Full(Bytes::from(text))
    }
}

impl PageBody {
    /// A stream of these chunks.
    pub fn stream<S>(stream: S) -> Self
    where
        S: Stream<Item = io::Result<Bytes>> + Send + 'static,
    {
        Self::Stream(stream.boxed())
    }

    /// All of it.
    pub async fn bytes(self) -> io::Result<Bytes> {
        match self {
            Self::Empty => Ok(Bytes::new()),
            Self::Full(bytes) => Ok(bytes),
            Self::Stream(mut stream) => {
                let mut out = BytesMut::new();
                while let Some(chunk) = stream.next().await {
                    out.extend_from_slice(&chunk?);
                }
                Ok(out.freeze())
            }
        }
    }

    /// All of it, or `None` past `max` bytes (readCapped).
    pub(crate) async fn capped(self, max: u64) -> io::Result<Option<Bytes>> {
        match self {
            Self::Empty => Ok(Some(Bytes::new())),
            Self::Full(bytes) => Ok((bytes.len() as u64 <= max).then_some(bytes)),
            Self::Stream(mut stream) => {
                let mut out = BytesMut::new();
                while let Some(chunk) = stream.next().await {
                    out.extend_from_slice(&chunk?);
                    if out.len() as u64 > max {
                        return Ok(None);
                    }
                }
                Ok(Some(out.freeze()))
            }
        }
    }

    /// Streamed, cut off with an error past `max` bytes (capped).
    pub(crate) fn cut_off_past(self, max: u64) -> Self {
        match self {
            Self::Stream(stream) => {
                let mut seen: u64 = 0;
                let mut over = false;
                Self::Stream(
                    stream
                        .map(move |chunk| {
                            let chunk = chunk?;
                            seen += chunk.len() as u64;
                            if seen > max {
                                return Err(io::Error::other("response too large"));
                            }
                            Ok(chunk)
                        })
                        .take_while(move |chunk| {
                            let go = !over;
                            over = chunk.is_err();
                            std::future::ready(go)
                        })
                        .boxed(),
                )
            }
            Self::Full(bytes) if bytes.len() as u64 > max => Self::stream(
                futures_util::stream::iter([Err(io::Error::other("response too large"))]),
            ),
            other => other,
        }
    }
}

/// A page's text: its bytes as UTF-8, a BOM dropped (`Response.text()`,
/// `TextDecoder`).
pub(crate) fn decoded(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// A file read for a page (a FileDownloadResult): its bytes and size.
#[derive(Debug)]
pub struct RenderedFile {
    pub body: PageBody,
    pub size: u64,
    pub content_type: String,
}

/// Why a file was not read: its message, and 413 for a file over the
/// SSH read's limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadError {
    pub message: String,
    pub status: Option<u16>,
}

impl ReadError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }

    pub fn too_large(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: Some(413),
        }
    }
}

impl From<io::Error> for ReadError {
    fn from(error: io::Error) -> Self {
        Self::new(error.to_string())
    }
}

/// Reads a file of `root` on the connection's host, confined to it
/// (createRenderedPages' readFile).
pub trait PageReader: Send + Sync + 'static {
    fn read_file(
        &self,
        connection_id: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>>;
}

/// The nearest directory above `from` ([`site_root_candidates`]) holding
/// `path`, on the connection's host; `None` when none does or the search
/// failed (createRenderedPages' findRoot).
pub trait RootFinder: Send + Sync + 'static {
    fn find_root(
        &self,
        connection_id: String,
        from: String,
        path: String,
    ) -> BoxFuture<Option<String>>;
}

/// What the reader of every connection needs from the host: a
/// connection's SSH destination, and the Files view's download helpers
/// (`path` relative to `root`, confined to it, links followed).
pub trait FileHosts: Send + Sync + 'static {
    /// The connection's SSH destination; `None` for this host.
    fn ssh_host(&self, connection_id: &str) -> Option<String>;
    fn read_local(&self, root: String, path: String) -> BoxFuture<Result<RenderedFile, ReadError>>;
    fn read_remote(
        &self,
        host: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>>;
}

/// How long a file read over SSH is kept for the pages that follow.
pub const RENDERED_REMOTE_CACHE_MS: i64 = 15_000;
/// What all kept files may weigh together; a larger file is read each time.
pub const RENDERED_REMOTE_CACHE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct FileCacheConfig {
    pub cache_ms: i64,
    pub cache_file_bytes: Option<u64>,
    pub cache_bytes: u64,
}

impl Default for FileCacheConfig {
    fn default() -> Self {
        Self {
            cache_ms: RENDERED_REMOTE_CACHE_MS,
            cache_file_bytes: None,
            cache_bytes: RENDERED_REMOTE_CACHE_BYTES,
        }
    }
}

struct Kept {
    key: (String, String, String),
    bytes: Bytes,
    content_type: String,
    until: i64,
}

#[derive(Default)]
struct Cache {
    /// Least recently used first.
    kept: Vec<Kept>,
    kept_bytes: u64,
    sweeping: bool,
}

impl Cache {
    fn drop_at(&mut self, index: usize) {
        let gone = self.kept.remove(index);
        self.kept_bytes -= gone.bytes.len() as u64;
    }

    fn drop_expired(&mut self, at: i64) {
        let mut index = 0;
        while index < self.kept.len() {
            if self.kept[index].until <= at {
                self.drop_at(index);
            } else {
                index += 1;
            }
        }
    }
}

struct ReaderInner {
    hosts: Arc<dyn FileHosts>,
    clock: SharedClock,
    cache_ms: i64,
    total_max: u64,
    file_max: u64,
    cache: Mutex<Cache>,
}

/// The pages' file reader for every connection: files of this host read
/// here, a connection over SSH's read on its host. A read over SSH is a
/// process on the far host, and a site's pages share their style sheets,
/// scripts and images: a remote file is kept a few seconds (within a
/// total), keyed by connection, root and path.
#[derive(Clone)]
pub struct ConnectionFileReader(Arc<ReaderInner>);

fn copy(bytes: &Bytes, content_type: &str) -> RenderedFile {
    RenderedFile {
        body: PageBody::Full(bytes.clone()),
        size: bytes.len() as u64,
        content_type: content_type.to_owned(),
    }
}

impl ConnectionFileReader {
    pub fn new(hosts: Arc<dyn FileHosts>, clock: SharedClock, config: FileCacheConfig) -> Self {
        let total_max = config.cache_bytes;
        Self(Arc::new(ReaderInner {
            hosts,
            clock,
            cache_ms: config.cache_ms,
            total_max,
            file_max: config.cache_file_bytes.unwrap_or(total_max).min(total_max),
            cache: Mutex::new(Cache::default()),
        }))
    }

    /// Kept files go once their time is up, even when nothing reads again.
    fn schedule_sweep(inner: &Arc<ReaderInner>) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let weak: Weak<ReaderInner> = Arc::downgrade(inner);
        let sleep = inner
            .clock
            .sleep(Duration::from_millis(inner.cache_ms.max(0) as u64));
        runtime.spawn(async move {
            sleep.await;
            let Some(inner) = weak.upgrade() else { return };
            let again = {
                let mut cache = inner.cache.lock().unwrap();
                cache.sweeping = false;
                cache.drop_expired(inner.clock.now());
                if cache.kept.is_empty() {
                    false
                } else {
                    cache.sweeping = true;
                    true
                }
            };
            if again {
                Self::schedule_sweep(&inner);
            }
        });
    }

    async fn read(
        inner: Arc<ReaderInner>,
        connection_id: String,
        root: String,
        path: String,
    ) -> Result<RenderedFile, ReadError> {
        // page_path already refuses these; never hand the helpers an
        // absolute path (they read those anywhere) or a step up.
        if !roamgate_base::paths::is_host_path(&root)
            || path.is_empty()
            || path.starts_with('/')
            || path.contains('\0')
            || path.contains('\\')
            || path
                .split('/')
                .any(|part| part == ".." || part == "." || part.is_empty())
        {
            return Err(ReadError::new("invalid path"));
        }
        let Some(host) = inner.hosts.ssh_host(&connection_id) else {
            return inner.hosts.read_local(root, path).await;
        };
        let key = (connection_id, root.clone(), path.clone());
        let at = inner.clock.now();
        {
            let mut cache = inner.cache.lock().unwrap();
            if let Some(index) = cache.kept.iter().position(|kept| kept.key == key) {
                if cache.kept[index].until > at {
                    // Most recently used last: the oldest go first.
                    let hit = cache.kept.remove(index);
                    let file = copy(&hit.bytes, &hit.content_type);
                    cache.kept.push(hit);
                    return Ok(file);
                }
                cache.drop_at(index);
            }
        }
        let file = inner.hosts.read_remote(host, root, path).await?;
        // A directory reads as an archive (served as a redirect to its
        // index): never kept, whatever size it says.
        if file.size > inner.file_max
            || inner.cache_ms <= 0
            || file.content_type == "application/gzip"
        {
            return Ok(file);
        }
        let content_type = file.content_type;
        let bytes = file.body.bytes().await?;
        let schedule = {
            let mut cache = inner.cache.lock().unwrap();
            cache.drop_expired(at);
            let size = bytes.len() as u64;
            while cache.kept_bytes + size > inner.total_max && !cache.kept.is_empty() {
                cache.drop_at(0);
            }
            if cache.kept_bytes + size <= inner.total_max {
                cache.kept.push(Kept {
                    key,
                    bytes: bytes.clone(),
                    content_type: content_type.clone(),
                    until: at + inner.cache_ms,
                });
                cache.kept_bytes += size;
                !std::mem::replace(&mut cache.sweeping, true)
            } else {
                false
            }
        };
        if schedule {
            Self::schedule_sweep(&inner);
        }
        Ok(copy(&bytes, &content_type))
    }
}

impl PageReader for ConnectionFileReader {
    fn read_file(
        &self,
        connection_id: String,
        root: String,
        path: String,
    ) -> BoxFuture<Result<RenderedFile, ReadError>> {
        Box::pin(Self::read(self.0.clone(), connection_id, root, path))
    }
}

/// How many directories above a listed one its site's root is looked for.
pub const SITE_ROOT_MAX_LEVELS: usize = 8;

/// The directories a listed directory's site root may be, nearest first:
/// those above `from`, at most [`SITE_ROOT_MAX_LEVELS`], never `/`, nor
/// `home` or a directory above it (whose files a page must not reach).
pub fn site_root_candidates(from: &str, home: &str) -> Vec<String> {
    let mut out = Vec::new();
    let home_dir = home.trim_end_matches('/');
    let mut at = from.trim_end_matches('/').to_owned();
    while out.len() < SITE_ROOT_MAX_LEVELS {
        match at.rfind('/') {
            Some(slash) => at.truncate(slash),
            None => {
                at.pop();
            }
        }
        if at.is_empty() {
            break;
        }
        if !home_dir.is_empty() && format!("{home_dir}/").starts_with(&format!("{at}/")) {
            break;
        }
        out.push(at.clone());
    }
    out
}

/// The shell script finding a site's root on a host over SSH
/// (contract/assets/sh/site-root.sh): the first of
/// `site_root_candidates(from, $HOME)` holding `path`, printed; exit 44 if
/// none.
pub fn site_root_script(from: &str, path: &str, quote: &dyn Fn(&str) -> String) -> String {
    fill_template(
        SITE_ROOT_SH,
        &[
            (
                "dir",
                TemplateValue::Text(quote(from.trim_end_matches('/'))),
            ),
            ("rel", TemplateValue::Text(quote(path))),
            (
                "max_levels",
                TemplateValue::Number(SITE_ROOT_MAX_LEVELS as f64),
            ),
        ],
    )
    .expect("the site root script's tags are filled")
}

/// What an SSH run of a script gave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptOutput {
    pub code: i32,
    pub stdout: String,
}

/// What the root finder needs from the host.
pub trait RootHosts: Send + Sync + 'static {
    /// The connection's SSH destination; `None` for this host.
    fn ssh_host(&self, connection_id: &str) -> Option<String>;
    /// Whether `path` exists on this host.
    fn exists(&self, path: String) -> BoxFuture<bool>;
    /// `sh -c <script>` on `host`: its exit code and output.
    fn run_remote(&self, host: String, script: String) -> BoxFuture<Result<ScriptOutput, String>>;
}

/// The pages' site root finder for every connection: the directories
/// above a listed one are tried here for this host, or by one command
/// ([`site_root_script`]) on a connection's host over SSH.
pub struct ConnectionRootFinder {
    hosts: Arc<dyn RootHosts>,
    /// This host's home directory.
    home: String,
    quote: fn(&str) -> String,
}

impl ConnectionRootFinder {
    /// `quote`: the host's shell quoting (`roamgate_exec::quote::shell_quote`).
    pub fn new(
        hosts: Arc<dyn RootHosts>,
        home: impl Into<String>,
        quote: fn(&str) -> String,
    ) -> Self {
        Self {
            hosts,
            home: home.into(),
            quote,
        }
    }
}

impl RootFinder for ConnectionRootFinder {
    fn find_root(
        &self,
        connection_id: String,
        from: String,
        path: String,
    ) -> BoxFuture<Option<String>> {
        let hosts = self.hosts.clone();
        let home = self.home.clone();
        let quote = self.quote;
        Box::pin(async move {
            if !from.starts_with('/')
                || page_path(&path).as_deref() != Some(path.as_str())
                || path.split('/').any(|part| part == "." || part == "..")
            {
                return None;
            }
            let Some(host) = hosts.ssh_host(&connection_id) else {
                for candidate in site_root_candidates(&from, &home) {
                    if hosts.exists(format!("{candidate}/{path}")).await {
                        return Some(candidate);
                    }
                }
                return None;
            };
            let result = hosts
                .run_remote(host, site_root_script(&from, &path, &quote))
                .await
                .ok()?;
            let found = js::trim(&result.stdout);
            (result.code == 0 && found.starts_with('/')).then(|| found.to_owned())
        })
    }
}
