//! `session-resolver.ts`: which transcript a pane's agent writes, from what
//! Herdr says of it (its session id or path), else from its directory.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::Value;

use crate::antigravity;
use crate::files::{AgentEnv, BoxFut, SessionFiles, local_stat};
use crate::grok;
use crate::js::{self, Obj, sv};
use crate::paths::resolve;
use crate::projection::Resolved;
use crate::session::SessionFile;
use crate::utils::{basename, integration_install_command, normalize_agent_name};

/// Herdr's API, as the readers call it (`HerdrCall`).
pub trait HerdrCall: Send + Sync {
    fn call(
        &self,
        method: &str,
        params: Value,
        timeout_ms: Option<u64>,
    ) -> BoxFut<'_, Result<Value, String>>;
}

/// A Muse transcript's path, its stamp and the workspace it names.
type MuseMetadata = (String, (String, Option<String>));

/// What the resolver keeps between calls (one per connection).
#[derive(Default)]
pub struct ResolverContext {
    path_cache: Mutex<HashMap<String, String>>,
    /// When a Claude session's id was last searched for in the whole
    /// projects tree and not found (see [`CLAUDE_WALK_MISS_MS`]).
    claude_walk_misses: Mutex<HashMap<String, f64>>,
    successor_checked: Mutex<HashMap<String, f64>>,
    muse_metadata: Mutex<Vec<MuseMetadata>>,
    pub env: AgentEnv,
}

impl ResolverContext {
    pub fn new(env: AgentEnv) -> Self {
        Self {
            env,
            ..Default::default()
        }
    }
}

const CLAUDE_SUCCESSOR_CHECK_MS: f64 = 30_000.0;

fn walk_files(root: &Path, matches: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    fn visit(
        dir: &Path,
        depth: usize,
        matches: &dyn Fn(&Path) -> bool,
        results: &mut Vec<PathBuf>,
    ) {
        if depth > 8 || results.len() > 200 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            // The entry's own type, as Bun's `withFileTypes`: only a link
            // is followed with a stat (a project folder may link to where
            // sessions are kept; the depth limit ends a loop of links).
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let (is_dir, is_file) = if kind.is_symlink() {
                match std::fs::metadata(&path) {
                    Ok(meta) => (meta.is_dir(), meta.is_file()),
                    Err(_) => continue,
                }
            } else {
                (kind.is_dir(), kind.is_file())
            };
            if is_dir {
                visit(&path, depth + 1, matches, results);
            } else if is_file && matches(&path) {
                results.push(path);
            }
        }
    }
    let mut results = Vec::new();
    visit(root, 0, matches, &mut results);
    results
}

fn newest_file(paths: Vec<PathBuf>) -> Option<String> {
    let mut found: Vec<(String, f64)> = paths
        .into_iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some((
                path.to_string_lossy().into_owned(),
                crate::paths::mtime_ms(&meta),
            ))
        })
        .collect();
    found.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    found.into_iter().next().map(|(p, _)| p)
}

fn cached_path(
    context: &ResolverContext,
    key: &str,
    resolve_path: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Some(cached) = context.path_cache.lock().unwrap().get(key).cloned()
        && Path::new(&cached).exists()
    {
        return Some(cached);
    }
    let path = resolve_path()?;
    context
        .path_cache
        .lock()
        .unwrap()
        .insert(key.to_owned(), path.clone());
    Some(path)
}

/// How long a Claude session id the whole projects tree did not have is
/// not searched for there again (its project folder still is, each time):
/// the walk is hundreds of thousands of entries on a busy machine, and an
/// id with no transcript here (another host's, one gone) was searched for
/// on every agent list.
pub const CLAUDE_WALK_MISS_MS: f64 = 60_000.0;

async fn find_claude_session(id: &str, context: &ResolverContext) -> Option<String> {
    let key = format!("claude:{id}");
    if let Some(cached) = context.path_cache.lock().unwrap().get(&key).cloned()
        && Path::new(&cached).exists()
    {
        return Some(cached);
    }
    let now = js::now_ms();
    let walk = context
        .claude_walk_misses
        .lock()
        .unwrap()
        .get(&key)
        .is_none_or(|at| now - at >= CLAUDE_WALK_MISS_MS);
    let root = context.env.home.join(".claude").join("projects");
    let name = format!("{id}.jsonl");
    // Off the async workers: a walk is long, and blocking work.
    let found = tokio::task::spawn_blocking(move || {
        // Where Claude Code keeps it: straight under its project's folder.
        // Only when it is not there is the whole tree walked.
        let direct: Vec<PathBuf> = std::fs::read_dir(&root)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|e| e.path().join(&name))
                    .filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file()))
                    .collect()
            })
            .unwrap_or_default();
        if !direct.is_empty() {
            return newest_file(direct);
        }
        if !walk {
            return None;
        }
        newest_file(walk_files(&root, &|path| {
            path.file_name()
                .is_some_and(|n| n.to_string_lossy() == name)
        }))
    })
    .await
    .ok()
    .flatten();
    let mut misses = context.claude_walk_misses.lock().unwrap();
    match &found {
        Some(path) => {
            misses.remove(&key);
            drop(misses);
            context.path_cache.lock().unwrap().insert(key, path.clone());
        }
        None if walk => {
            misses.retain(|_, at| now - *at < CLAUDE_WALK_MISS_MS);
            misses.insert(key, now);
        }
        None => {}
    }
    found
}

async fn find_claude_transcript(
    id: &str,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Option<SessionFile>> {
    let key = format!(
        "claude:{}:{id}",
        if files.remote() { "remote" } else { "local" }
    );
    let mut file = None;
    if files.remote() {
        let cached = context.path_cache.lock().unwrap().get(&key).cloned();
        if let Some(cached) = cached {
            file = files.stat_file(&cached).await?;
        }
        if file.is_none() {
            context.path_cache.lock().unwrap().remove(&key);
            file = files.find_claude_session_by_id(id).await?;
            if let Some(found) = &file {
                context
                    .path_cache
                    .lock()
                    .unwrap()
                    .insert(key.clone(), found.path.clone());
            }
        }
    } else if let Some(path) = find_claude_session(id, context).await {
        file = files.stat_file(&path).await?;
    }
    let Some(file) = file else { return Ok(None) };
    let successor_key = format!("{key}:successor");
    let checked = context
        .successor_checked
        .lock()
        .unwrap()
        .get(&successor_key)
        .copied()
        .unwrap_or(0.0);
    let now = js::now_ms();
    if now - checked >= CLAUDE_SUCCESSOR_CHECK_MS {
        context
            .successor_checked
            .lock()
            .unwrap()
            .insert(successor_key.clone(), now);
        let successor = files
            .find_claude_successor(&file.path, id)
            .await
            .ok()
            .flatten();
        let mut cache = context.path_cache.lock().unwrap();
        match successor {
            Some(next) => {
                cache.insert(successor_key.clone(), next);
            }
            None => {
                cache.remove(&successor_key);
            }
        }
    }
    let successor = context
        .path_cache
        .lock()
        .unwrap()
        .get(&successor_key)
        .cloned();
    if let Some(successor) = successor
        && let Some(next) = files.stat_file(&successor).await?
    {
        return Ok(Some(next));
    }
    Ok(Some(file))
}

/// The id of the session a Claude session went on in, if another.
pub async fn claude_successor_id(
    id: &str,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Option<String>> {
    static UUID: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$").unwrap());
    if !UUID.is_match(id) {
        return Ok(None);
    }
    let file = find_claude_transcript(id, files, context).await?;
    let next = file
        .map(|f| crate::files::session_name(&f.path))
        .unwrap_or_default();
    Ok((!next.is_empty() && next != id).then_some(next))
}

async fn find_codex_session(
    id: &str,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Option<SessionFile>> {
    let home = if files.remote() {
        "remote".to_owned()
    } else {
        context.env.codex_home().to_string_lossy().into_owned()
    };
    let key = format!("codex:{home}:{id}");
    let cached = context.path_cache.lock().unwrap().get(&key).cloned();
    if let Some(cached) = cached {
        if let Some(file) = files.stat_file(&cached).await? {
            return Ok(Some(file));
        }
        context.path_cache.lock().unwrap().remove(&key);
    }
    let file = files.find_codex_session_by_id(id).await?;
    if let Some(found) = &file {
        context
            .path_cache
            .lock()
            .unwrap()
            .insert(key, found.path.clone());
    }
    Ok(file)
}

fn session_name_matches(path: &Path, id: &str) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    name == format!("{id}.jsonl") || name.ends_with(&format!("_{id}.jsonl"))
}

fn find_kimi_session(id: &str, context: &ResolverContext) -> Option<String> {
    cached_path(context, &format!("kimi:{id}"), || {
        let root = context.env.home.join(".kimi-code").join("sessions");
        let suffix = format!("{id}/agents/main/wire.jsonl");
        newest_file(walk_files(&root, &|path| {
            let text = path.to_string_lossy();
            text.ends_with(&suffix) || text.contains(&format!("/{id}/agents/main/wire.jsonl"))
        }))
    })
}

fn find_pi_session(id: &str, context: &ResolverContext) -> Option<String> {
    cached_path(context, &format!("pi:{id}"), || {
        newest_file(walk_files(
            &context.env.pi_agent_dir().join("sessions"),
            &|p| session_name_matches(p, id),
        ))
    })
}

fn find_omp_session(id: &str, context: &ResolverContext) -> Option<String> {
    cached_path(context, &format!("omp:{id}"), || {
        let env = &context.env;
        let configured = env
            .var("PI_CONFIG_DIR")
            .filter(|v| !v.is_empty())
            .unwrap_or(".omp");
        // path.join: an absolute PI_CONFIG_DIR is still below home.
        let omp_root = crate::paths::normalize(Path::new(&format!(
            "{}/{configured}",
            env.home.to_string_lossy()
        )));
        let mut roots: Vec<PathBuf> = vec![omp_root.join("agent").join("sessions")];
        let mut add = |root: PathBuf| {
            if !roots.contains(&root) {
                roots.push(root);
            }
        };
        if let Some(xdg) = env
            .var("XDG_DATA_HOME")
            .map(js::trim)
            .filter(|v| !v.is_empty())
        {
            let xdg_root = resolve(xdg).join("omp");
            add(xdg_root.join("sessions"));
            if let Ok(profiles) = std::fs::read_dir(xdg_root.join("profiles")) {
                for profile in profiles.filter_map(Result::ok) {
                    if profile.file_type().is_ok_and(|t| t.is_dir()) {
                        add(profile.path().join("sessions"));
                    }
                }
            }
        }
        if env
            .var("PI_CODING_AGENT_DIR")
            .map(js::trim)
            .is_some_and(|v| !v.is_empty())
        {
            add(env.pi_agent_dir().join("sessions"));
        }
        if let Ok(profiles) = std::fs::read_dir(omp_root.join("profiles")) {
            for profile in profiles.filter_map(Result::ok) {
                if profile.file_type().is_ok_and(|t| t.is_dir()) {
                    add(profile.path().join("agent").join("sessions"));
                }
            }
        }
        let files: Vec<PathBuf> = roots
            .iter()
            .flat_map(|root| walk_files(root, &|p| session_name_matches(p, id)))
            .collect();
        newest_file(files)
    })
}

// ---------------------------------------------------------------- Muse

fn muse_sessions_root(env: &AgentEnv) -> PathBuf {
    let configured = env
        .var("XDG_DATA_HOME")
        .map(js::trim)
        .filter(|v| !v.is_empty() && Path::new(v).is_absolute());
    configured
        .map(PathBuf::from)
        .unwrap_or_else(|| env.home.join(".local").join("share"))
        .join("muse")
        .join("sessions")
}

fn canonical_directory(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| resolve(path))
}

#[cfg(test)]
thread_local! {
    /// How many Muse metadata prefixes were read (the TS test spies on
    /// readPrefix).
    pub(crate) static MUSE_WORKSPACE_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn read_muse_workspace(path: &str) -> Option<String> {
    use std::io::Read;
    #[cfg(test)]
    MUSE_WORKSPACE_READS.with(|reads| reads.set(reads.get() + 1));
    let mut prefix = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(256 * 1024)
        .read_to_end(&mut prefix)
        .ok()?;
    for line in String::from_utf8_lossy(&prefix).split('\n') {
        if js::trim(line).is_empty() {
            continue;
        }
        // A line that does not parse ends the search, as Bun's throw does.
        let record = js::parse(line)?;
        if sv(record.get("payload_type")) == "runtime.session.metadata"
            && let Some(inner) = record
                .get("payload")
                .and_then(|p| p.get("record"))
                .and_then(Value::as_object)
        {
            return js::truthy(sv(inner.get("workspace_root"))).map(str::to_owned);
        }
    }
    None
}

/// The newest top-level Muse session with this id, or for this directory.
pub fn find_muse_session(
    id: Option<&str>,
    cwd: Option<&str>,
    context: Option<&ResolverContext>,
    env: &AgentEnv,
) -> Option<SessionFile> {
    match id {
        Some(id) => {
            if id == "." || id == ".." || id.contains(['\\', '/', '\0']) {
                return None;
            }
        }
        None if cwd.is_none_or(str::is_empty) => return None,
        None => {}
    }
    let root = muse_sessions_root(env);
    let mut candidates: Vec<SessionFile> = Vec::new();
    let years = std::fs::read_dir(&root).ok()?;
    let digits = |name: &str, len: usize| name.chars().count() == len;
    let sorted = |dir: &Path| -> Vec<PathBuf> {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|e| e.filter_map(Result::ok).map(|e| e.path()).collect())
            .unwrap_or_default();
        entries.sort();
        entries
    };
    let mut years: Vec<PathBuf> = years.filter_map(Result::ok).map(|e| e.path()).collect();
    years.sort();
    for year in years
        .iter()
        .filter(|p| digits(basename(&p.to_string_lossy()), 4))
    {
        for month in sorted(year)
            .iter()
            .filter(|p| digits(basename(&p.to_string_lossy()), 2))
        {
            for day in sorted(month)
                .iter()
                .filter(|p| digits(basename(&p.to_string_lossy()), 2))
            {
                for session in sorted(day) {
                    let name = basename(&session.to_string_lossy()).to_owned();
                    if id.is_some_and(|id| id != name) {
                        continue;
                    }
                    let path = session.join("session.jsonl").to_string_lossy().into_owned();
                    if let Some(file) = local_stat(&path) {
                        candidates.push(file);
                    }
                }
            }
        }
    }
    candidates.sort_by(|a, b| {
        b.mtime_ms
            .partial_cmp(&a.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let directory = cwd.map(canonical_directory);
    for file in candidates {
        let session_id = basename(&crate::utils::dirname(&file.path)).to_owned();
        if let Some(id) = id {
            return Some(SessionFile {
                session_id: Some(id.to_owned()),
                ..file
            });
        }
        let workspace = match context {
            Some(context) => {
                let signature = js::stringify(&serde_json::json!([
                    file.identity,
                    file.change_token,
                    file.size,
                    file.mtime_ms
                ]));
                let mut cache = context.muse_metadata.lock().unwrap();
                let entry = cache.iter().position(|(p, _)| *p == file.path);
                let workspace = match entry.filter(|at| cache[*at].1.0 == signature) {
                    Some(at) => cache.remove(at).1.1,
                    None => {
                        if let Some(at) = entry {
                            cache.remove(at);
                        }
                        read_muse_workspace(&file.path)
                    }
                };
                if workspace.is_some() {
                    cache.push((file.path.clone(), (signature, workspace.clone())));
                    while cache.len() > 512 {
                        cache.remove(0);
                    }
                }
                workspace
            }
            None => read_muse_workspace(&file.path),
        };
        if let (Some(workspace), Some(directory)) = (workspace, &directory)
            && canonical_directory(&workspace) == *directory
        {
            return Some(SessionFile {
                session_id: Some(session_id),
                ..file
            });
        }
    }
    None
}

// ---------------------------------------------------------------- resolve

/// Herdr's session of an agent (`agent_session`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub source: String,
    pub agent: String,
    pub kind: String,
    pub value: String,
}

impl SessionInfo {
    pub fn to_value(&self) -> Value {
        Value::Object(obj! {
            "source" => self.source.clone(),
            "agent" => self.agent.clone(),
            "kind" => self.kind.clone(),
            "value" => self.value.clone(),
        })
    }
}

fn parse_agent_session(agent: Option<&Obj>) -> Option<SessionInfo> {
    let raw = js::rec(agent?.get("agent_session"))?;
    let kind = sv(raw.get("kind")).to_lowercase();
    let value = sv(raw.get("value"));
    if (kind != "id" && kind != "path") || value.is_empty() {
        return None;
    }
    Some(SessionInfo {
        source: sv(raw.get("source")).to_owned(),
        agent: sv(raw.get("agent")).to_owned(),
        kind,
        value: value.to_owned(),
    })
}

async fn session_file_for(
    agent: &str,
    session: &SessionInfo,
    cwd: &str,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Option<SessionFile>> {
    let grok_root = || grok::grok_sessions_root(&context.env.home, context.env.var("GROK_HOME"));
    if agent == "grok" {
        let found = if session.kind == "path" {
            grok::describe_grok_session_path(&resolve(&session.value))
        } else {
            grok::find_grok_session_by_id(&session.value, cwd, &grok_root())
        };
        return Ok(found.map(|d| d.file));
    }
    if agent == "agy" {
        let found = if session.kind == "path" {
            antigravity::describe_antigravity_session_path(&resolve(&session.value))
        } else {
            antigravity::find_antigravity_session_by_id(
                &session.value,
                cwd,
                &antigravity::antigravity_conversations_root(&context.env),
            )
        };
        return Ok(found.map(|d| d.file));
    }
    if session.kind == "path" {
        // A remote host's absolute path is POSIX, whatever this machine is.
        let path = if files.remote() && session.value.starts_with('/') {
            roamgate_base::paths::resolve_posix(&session.value)
        } else {
            resolve(&session.value).to_string_lossy().into_owned()
        };
        return files.stat_file(&path).await;
    }
    if agent == "muse" {
        return Ok(if files.remote() {
            None
        } else {
            find_muse_session(Some(&session.value), None, None, &context.env)
        });
    }
    if agent == "pi" && files.remote() {
        return files.find_pi_session_by_id(&session.value).await;
    }
    if agent == "codex" {
        return find_codex_session(&session.value, files, context).await;
    }
    if agent == "claude" {
        return find_claude_transcript(&session.value, files, context).await;
    }
    let path = match agent {
        "kimi" => find_kimi_session(&session.value, context),
        "omp" if files.remote() => None,
        "omp" => find_omp_session(&session.value, context),
        "pi" => find_pi_session(&session.value, context),
        _ => None,
    };
    match path {
        Some(path) => files.stat_file(&path).await,
        None => Ok(None),
    }
}

/// The pane's session, as Herdr's `agent.get` says it.
pub async fn resolve_agent_session(
    params: &Value,
    herdr: &dyn HerdrCall,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Resolved> {
    let pane = sv(params.get("pane_id"));
    if pane.is_empty() {
        return Err(io::Error::other("agent session requires pane_id"));
    }
    let result = herdr
        .call("agent.get", serde_json::json!({ "target": pane }), None)
        .await
        .map_err(io::Error::other)?;
    let agent = result.get("agent").and_then(Value::as_object).cloned();
    resolve_agent_session_info(params, agent.as_ref(), files, context).await
}

/// Resolves an agent snapshot without another Herdr request.
pub async fn resolve_agent_session_info(
    params: &Value,
    agent_info: Option<&Obj>,
    files: &dyn SessionFiles,
    context: &ResolverContext,
) -> io::Result<Resolved> {
    let pane = sv(params.get("pane_id"));
    if pane.is_empty() {
        return Err(io::Error::other("agent session requires pane_id"));
    }
    let session = parse_agent_session(agent_info);
    let info = |key: &str| agent_info.map_or("", |a| sv(a.get(key)));
    let raw_agent = js::truthy(info("agent"))
        .or(session
            .as_ref()
            .map(|s| s.agent.as_str())
            .filter(|a| !a.is_empty()))
        .or(js::truthy(sv(params.get("agent"))))
        .unwrap_or("");
    let agent = normalize_agent_name(raw_agent);
    if ![
        "codex", "claude", "kimi", "grok", "pi", "omp", "muse", "agy",
    ]
    .contains(&agent.as_str())
    {
        return Err(io::Error::other(
            "agent session only supports codex, claude, kimi, grok, pi, omp, muse, and agy",
        ));
    }
    let cwd = js::truthy(info("foreground_cwd"))
        .unwrap_or(info("cwd"))
        .to_owned();
    let mut base = obj! {
        "version" => 1i64,
        "agent" => agent.clone(),
        "pane_id" => pane,
        "workspace_id" => js::truthy(info("workspace_id")).unwrap_or(sv(params.get("workspace_id"))),
        "tab_id" => js::truthy(info("tab_id")).unwrap_or(sv(params.get("tab_id"))),
    };
    let mut resolved_session = session;
    let mut file: Option<SessionFile> = None;
    let make = |source: &str, value: String| SessionInfo {
        source: source.into(),
        agent: agent.clone(),
        kind: "id".into(),
        value,
    };
    if agent == "grok" && resolved_session.is_none() {
        let root = grok::grok_sessions_root(&context.env.home, context.env.var("GROK_HOME"));
        if let Some(found) = grok::find_grok_session_for_cwd(&cwd, &root) {
            resolved_session = Some(make("grok-local", found.session_id.clone()));
            file = Some(found.file);
        }
    }
    if agent == "agy" && resolved_session.is_none() {
        let root = antigravity::antigravity_conversations_root(&context.env);
        if let Some(found) = antigravity::find_antigravity_session_for_cwd(&cwd, &root) {
            resolved_session = Some(make("agy-local", found.session.session_id.clone()));
            file = Some(found.file);
        }
    }
    if agent == "pi" && resolved_session.is_none() && !cwd.is_empty() {
        static ID: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?:^|_)([^_]+)\.jsonl$").unwrap());
        if let Some(found) = files.find_pi_session_for_cwd(&cwd).await?
            && let Some(id) = ID.captures(basename(&found.path)).map(|c| c[1].to_owned())
        {
            resolved_session = Some(make("pi-local", id));
            file = Some(found);
        }
    }
    if agent == "muse" && resolved_session.is_none() && !files.remote() {
        file = find_muse_session(None, Some(&cwd), Some(context), &context.env);
        if let Some(id) = file
            .as_ref()
            .and_then(|f| f.session_id.clone())
            .filter(|i| !i.is_empty())
        {
            resolved_session = Some(make("muse-local", id));
        }
    }
    let epoch = js::iso(0.0);
    let Some(session) = resolved_session else {
        let detail = match agent.as_str() {
            "muse" if files.remote() => "Muse session inspection over SSH requires a Herdr-reported transcript path. Local session discovery is not used for remote panes.".to_owned(),
            "muse" if !cwd.is_empty() => format!("No local Muse Code session was found for {cwd}. Start Muse Code in this directory without --no-session-log, then refresh Session Inspect."),
            "muse" => "Herdr did not report a working directory for this Muse Code pane.".to_owned(),
            "grok" if !cwd.is_empty() => format!("No local Grok Build session was found for {cwd}. Start Grok Build in this directory, then refresh Session Inspect."),
            "grok" => "Herdr did not report a working directory for this Grok Build pane.".to_owned(),
            "agy" if !cwd.is_empty() => format!("No local Antigravity session was found for {cwd}. Start Antigravity in this directory, then refresh Session Inspect."),
            "agy" => "Herdr did not report a working directory for this Antigravity pane.".to_owned(),
            "codex" => "Herdr has not received this pane's Codex session. Install the Codex integration on the agent's machine and run Codex with --no-daemon so session hooks use this pane's environment. Existing shared-server sessions must be resumed with --no-daemon.".to_owned(),
            _ => "Herdr has not received an agent session id for this pane. Install the Herdr integration for this agent and start a new agent session.".to_owned(),
        };
        base.insert("status".into(), Value::String("missing_session".into()));
        base.insert("detail".into(), Value::String(detail));
        if agent != "grok" && agent != "muse" {
            base.insert(
                "command".into(),
                Value::String(integration_install_command(&agent)),
            );
        }
        base.insert("updated_at".into(), Value::String(epoch));
        base.insert("path".into(), Value::String(String::new()));
        base.insert("session".into(), Value::Null);
        base.insert("file".into(), Value::Null);
        return Ok(Resolved {
            value: base,
            agent,
            session_kind: None,
            session_value: None,
            file: None,
        });
    };
    if file.is_none() {
        file = session_file_for(&agent, &session, &cwd, files, context).await?;
    }
    let Some(file) = file else {
        base.insert("status".into(), Value::String("missing_file".into()));
        base.insert(
            "detail".into(),
            Value::String(format!(
                "Could not find the {agent} session transcript for {}.",
                session.value
            )),
        );
        base.insert("updated_at".into(), Value::String(epoch));
        base.insert("path".into(), Value::String(String::new()));
        base.insert("session".into(), session.to_value());
        base.insert("file".into(), Value::Null);
        return Ok(Resolved {
            value: base,
            agent,
            session_kind: Some(session.kind),
            session_value: Some(session.value),
            file: None,
        });
    };
    base.insert("status".into(), Value::String("ok".into()));
    base.insert("detail".into(), Value::String(String::new()));
    base.insert("updated_at".into(), Value::String(js::iso(file.mtime_ms)));
    base.insert("path".into(), Value::String(file.path.clone()));
    base.insert("session".into(), session.to_value());
    base.insert("file".into(), file.to_value());
    Ok(Resolved {
        value: base,
        agent,
        session_kind: Some(session.kind),
        session_value: Some(session.value),
        file: Some(file),
    })
}

#[cfg(test)]
mod tests;
