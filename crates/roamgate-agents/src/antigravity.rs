//! `antigravity-session.ts`: Antigravity CLI's sessions, one SQLite
//! database each, its steps protobuf blobs decoded into records the
//! trajectory reads. The database is copied (with its WAL) before it is
//! read, as Bun's reader does, so a live session is never locked.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::files::AgentEnv;
use crate::js::{self, Obj};
use crate::session::SessionFile;

/// One field of a protobuf message.
#[derive(Debug, Clone)]
pub struct ProtoField {
    pub field: i64,
    pub wire: i64,
    pub val: ProtoVal,
}

/// A varint (as JavaScript's number, a BigInt past 2^53 read as its float),
/// or bytes (wire types 1, 2 and 5).
#[derive(Debug, Clone)]
pub enum ProtoVal {
    Varint(u128),
    Bytes(Vec<u8>),
}

impl ProtoVal {
    /// `val` as JavaScript tests it (`f && f.val`).
    fn truthy(&self) -> bool {
        match self {
            ProtoVal::Varint(n) => *n != 0,
            ProtoVal::Bytes(_) => true,
        }
    }

    fn bytes(&self) -> Option<&[u8]> {
        match self {
            ProtoVal::Bytes(b) => Some(b),
            ProtoVal::Varint(_) => None,
        }
    }

    /// `Number(val)`: a varint's value; bytes as a Uint8Array converts
    /// (its elements joined by commas, read as a number).
    fn number(&self) -> f64 {
        match self {
            ProtoVal::Varint(n) => *n as f64,
            ProtoVal::Bytes(b) => {
                let text = b.iter().map(u8::to_string).collect::<Vec<_>>().join(",");
                js::number_from_text(&text)
            }
        }
    }
}

/// A varint at `pos`: its value and where the next byte is.
pub fn decode_varint(buf: &[u8], mut pos: usize) -> Option<(u128, usize)> {
    let mut res: u128 = 0;
    let mut shift: u32 = 0;
    while pos < buf.len() {
        let b = buf[pos];
        pos += 1;
        if shift < 128 {
            res |= u128::from(b & 0x7f) << shift;
        }
        shift += 7;
        if b & 0x80 == 0 {
            return Some((res, pos));
        }
    }
    None
}

/// `Number(x) & 7` and `>> 3` as JavaScript's int32 arithmetic gives them.
fn int32(value: u128) -> i32 {
    let as_f64 = value as f64;
    let wrapped = (as_f64 % 4_294_967_296.0) as u64;
    wrapped as u32 as i32
}

/// A message's fields as far as they decode.
pub fn decode_proto(buf: Option<&[u8]>) -> Vec<ProtoField> {
    let Some(buf) = buf else { return Vec::new() };
    let mut pos = 0usize;
    let mut fields = Vec::new();
    while pos < buf.len() {
        let Some((key, next)) = decode_varint(buf, pos) else {
            break;
        };
        pos = next;
        let key = int32(key);
        let wire = i64::from(key & 7);
        let field = i64::from(key >> 3);
        if field == 0 {
            break;
        }
        let val = match wire {
            0 => {
                let Some((v, next)) = decode_varint(buf, pos) else {
                    break;
                };
                pos = next;
                ProtoVal::Varint(v)
            }
            1 | 5 => {
                let size = if wire == 1 { 8 } else { 4 };
                let end = (pos + size).min(buf.len());
                let val = ProtoVal::Bytes(buf[pos.min(buf.len())..end].to_vec());
                pos += size;
                val
            }
            2 => {
                let Some((len, next)) = decode_varint(buf, pos) else {
                    break;
                };
                pos = next;
                let len = len as f64;
                if pos as f64 + len > buf.len() as f64 {
                    break;
                }
                let len = len as usize;
                let val = ProtoVal::Bytes(buf[pos..pos + len].to_vec());
                pos += len;
                val
            }
            _ => break,
        };
        fields.push(ProtoField { field, wire, val });
    }
    fields
}

fn find(fields: &[ProtoField], number: i64) -> Option<&ProtoField> {
    fields.iter().find(|f| f.field == number)
}

fn sub(field: &ProtoField) -> Vec<ProtoField> {
    decode_proto(field.val.bytes())
}

/// `toUtf8String`: bytes decoded (invalid sequences as U+FFFD), else "".
pub fn to_utf8_string(val: &ProtoVal) -> String {
    match val {
        ProtoVal::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        ProtoVal::Varint(_) => String::new(),
    }
}

static CONTROL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{fffd}]").unwrap());

/// A tool result's text: field 1 of its message, else its first clean
/// string field, else its bytes, without control characters.
pub fn extract_tool_output_text(val: Option<&ProtoVal>) -> String {
    let bytes = match val {
        Some(ProtoVal::Bytes(b)) if !b.is_empty() => b.as_slice(),
        _ => return String::new(),
    };
    let mut text = String::new();
    let fields = decode_proto(Some(bytes));
    match find(&fields, 1) {
        Some(f1) if f1.val.truthy() => text = to_utf8_string(&f1.val),
        _ => {
            for f in &fields {
                if f.wire == 2 && f.val.truthy() {
                    let candidate = to_utf8_string(&f.val);
                    if !CONTROL.is_match(&candidate) {
                        text = candidate;
                        break;
                    }
                }
            }
        }
    }
    if text.is_empty() {
        text = String::from_utf8_lossy(bytes).into_owned();
    }
    CONTROL.replace_all(&text, "").into_owned()
}

/// A copy of the database (and its WAL and shared memory), opened, for
/// `read`; the copy is removed after.
fn with_temp_db<T>(db_path: &Path, read: impl FnOnce(&Connection) -> T) -> std::io::Result<T> {
    let dir = tempfile::Builder::new().prefix("roamgate-agy-").tempdir()?;
    let name = db_path
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| "session.db".into());
    let copy = dir.path().join(&name);
    std::fs::copy(db_path, &copy)?;
    for suffix in ["-wal", "-shm"] {
        let mut from = db_path.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if from.exists() {
            let mut to = copy.as_os_str().to_owned();
            to.push(suffix);
            std::fs::copy(&from, PathBuf::from(to))?;
        }
    }
    let connection = Connection::open_with_flags(
        &copy,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(std::io::Error::other)?;
    Ok(read(&connection))
}

fn safe_session_id(value: &str) -> bool {
    !value.is_empty() && value != "." && value != ".." && !value.contains(['\\', '/', '\0'])
}

fn configured_dir(env: &AgentEnv, value: Option<&str>) -> Option<PathBuf> {
    let configured = js::trim(value?);
    if configured.is_empty() {
        return None;
    }
    if configured == "~" {
        return Some(env.home.clone());
    }
    if let Some(rest) = configured.strip_prefix("~/") {
        return Some(env.home.join(rest));
    }
    Some(crate::paths::resolve(configured))
}

/// `ANTIGRAVITY_HOME`, else `GEMINI_HOME`, else `~/.gemini/antigravity-cli`.
pub fn antigravity_home(env: &AgentEnv) -> PathBuf {
    let set = |name: &str| env.var(name).map(js::trim).filter(|v| !v.is_empty());
    configured_dir(env, set("ANTIGRAVITY_HOME").or_else(|| set("GEMINI_HOME")))
        .unwrap_or_else(|| env.home.join(".gemini").join("antigravity-cli"))
}

/// `ANTIGRAVITY_CONVERSATIONS_DIR`, else the home's `conversations`.
pub fn antigravity_conversations_root(env: &AgentEnv) -> PathBuf {
    configured_dir(env, env.var("ANTIGRAVITY_CONVERSATIONS_DIR"))
        .unwrap_or_else(|| antigravity_home(env).join("conversations"))
}

fn same_directory(left: &str, right: &str) -> bool {
    crate::paths::resolve(left) == crate::paths::resolve(right)
}

/// What a session's database says of it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AntigravitySession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub created_at_ms: Option<f64>,
    pub updated_at_ms: Option<f64>,
    pub model_name: Option<String>,
    pub agent_version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AntigravityDescriptor {
    pub session: AntigravitySession,
    pub file: SessionFile,
}

fn text_column(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        _ => None,
    }
}

fn blob_column(value: ValueRef<'_>) -> Option<Vec<u8>> {
    match value {
        ValueRef::Blob(b) => Some(b.to_vec()),
        ValueRef::Text(t) => Some(t.to_vec()),
        _ => None,
    }
}

fn one_blob(db: &Connection, sql: &str, params: impl rusqlite::Params) -> Option<Vec<u8>> {
    db.query_row(sql, params, |row| Ok(blob_column(row.get_ref(0)?)))
        .ok()
        .flatten()
}

/// The step's time (metadata field 1, its field 1 in seconds), in ms.
fn step_seconds_ms(metadata: Option<&[u8]>) -> Option<f64> {
    let meta = decode_proto(metadata);
    let ts = find(&meta, 1)?;
    let sub = sub(ts);
    let sec = find(&sub, 1)?;
    Some(sec.val.number() * 1000.0)
}

fn inspect_db(db: &Connection, fallback_id: &str) -> AntigravitySession {
    let mut session_id = fallback_id.to_owned();
    if let Ok((cascade, trajectory)) = db.query_row(
        "SELECT cascade_id, trajectory_id FROM trajectory_meta LIMIT 1",
        [],
        |row| Ok((text_column(row.get_ref(0)?), text_column(row.get_ref(1)?))),
    ) {
        if let Some(id) = cascade.filter(|s| !s.is_empty()) {
            session_id = id;
        } else if let Some(id) = trajectory.filter(|s| !s.is_empty()) {
            session_id = id;
        }
    }

    let mut cwd = None;
    if let Some(data) = one_blob(
        db,
        "SELECT data FROM trajectory_metadata_blob WHERE id = 'main' LIMIT 1",
        [],
    ) && !data.is_empty()
    {
        let fields = decode_proto(Some(&data));
        let raw = match (find(&fields, 7), find(&fields, 1)) {
            (Some(f7), _) => to_utf8_string(&f7.val),
            (None, Some(f1)) => to_utf8_string(&f1.val),
            _ => String::new(),
        };
        if let Some(rest) = raw.strip_prefix("file://") {
            cwd = Some(rest.to_owned());
        } else if !raw.is_empty() {
            cwd = Some(raw);
        }
    }

    let mut model_name = None;
    if let Some(data) = one_blob(
        db,
        "SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1",
        [],
    ) && !data.is_empty()
    {
        let fields = decode_proto(Some(&data));
        if let Some(f1) = find(&fields, 1)
            && let Some(f19) = find(&sub(f1), 19)
        {
            model_name = Some(to_utf8_string(&f19.val));
        }
    }

    let mut created_at_ms = None;
    let mut updated_at_ms = None;
    if let Ok((Some(min), max)) = db.query_row("SELECT MIN(idx), MAX(idx) FROM steps", [], |row| {
        Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?))
    }) {
        let at = |idx: Option<i64>| {
            let metadata = one_blob(db, "SELECT metadata FROM steps WHERE idx = ?", [idx])?;
            if metadata.is_empty() {
                return None;
            }
            step_seconds_ms(Some(&metadata))
        };
        created_at_ms = at(Some(min));
        updated_at_ms = at(max);
    }

    AntigravitySession {
        session_id,
        cwd,
        created_at_ms,
        updated_at_ms,
        model_name,
        agent_version: None,
    }
}

/// A database's session, or None when it is no file or cannot be copied.
pub fn describe_antigravity_session_path(path: &Path) -> Option<AntigravityDescriptor> {
    let mut target = crate::paths::normalize(&crate::paths::resolve(&path.to_string_lossy()));
    let meta = match std::fs::metadata(&target) {
        Ok(meta) => meta,
        Err(_) if !target.to_string_lossy().ends_with(".db") => {
            target = PathBuf::from(format!("{}.db", target.to_string_lossy()));
            std::fs::metadata(&target).ok()?
        }
        Err(_) => return None,
    };
    if !meta.is_file() {
        return None;
    }
    let mut mtime_ms = crate::paths::mtime_ms(&meta);
    if let Ok(wal) = std::fs::metadata(format!("{}-wal", target.to_string_lossy())) {
        let wal_ms = crate::paths::mtime_ms(&wal);
        if wal_ms > mtime_ms {
            mtime_ms = wal_ms;
        }
    }
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let fallback = name.strip_suffix(".db").unwrap_or(&name).to_owned();
    let metadata = with_temp_db(&target, |db| inspect_db(db, &fallback)).ok()?;
    let updated = metadata.updated_at_ms.unwrap_or(mtime_ms);
    let path = target.to_string_lossy().into_owned();
    Some(AntigravityDescriptor {
        file: SessionFile {
            path,
            mtime_ms: updated,
            size: Some(meta.len() as f64),
            session_id: Some(metadata.session_id.clone()),
            created_at_ms: metadata.created_at_ms,
            model_name: metadata.model_name.clone(),
            agent_version: Some("antigravity-cli".into()),
            ..Default::default()
        },
        session: AntigravitySession {
            updated_at_ms: Some(updated),
            agent_version: Some("antigravity-cli".into()),
            ..metadata
        },
    })
}

fn newest(
    descriptors: Vec<AntigravityDescriptor>,
    keep: impl Fn(&AntigravityDescriptor) -> bool,
) -> Option<AntigravityDescriptor> {
    let mut kept: Vec<_> = descriptors.into_iter().filter(keep).collect();
    // A stable sort, newest first, as toSorted keeps equal times in order.
    kept.sort_by(|a, b| {
        b.file
            .mtime_ms
            .partial_cmp(&a.file.mtime_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    kept.into_iter().next()
}

fn db_files(root: &Path, keep: impl Fn(&str) -> bool) -> Option<Vec<PathBuf>> {
    let entries = std::fs::read_dir(root).ok()?;
    Some(
        entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                (name.ends_with(".db") && keep(&name)).then(|| root.join(name))
            })
            .collect(),
    )
}

/// A session by its id, or the start of it (the newest in `cwd` when one
/// is given).
pub fn find_antigravity_session_by_id(
    id: &str,
    cwd: &str,
    root: &Path,
) -> Option<AntigravityDescriptor> {
    if !safe_session_id(id) {
        return None;
    }
    let filename = if id.ends_with(".db") {
        id.to_owned()
    } else {
        format!("{id}.db")
    };
    let direct = root.join(&filename);
    if direct.exists()
        && let Some(found) = describe_antigravity_session_path(&direct)
    {
        return Some(found);
    }
    let matches = db_files(root, |name| {
        name.starts_with(id) || name.strip_suffix(".db").unwrap_or(name).starts_with(id)
    })?;
    if matches.is_empty() {
        return None;
    }
    let descriptors = matches
        .iter()
        .filter_map(|p| describe_antigravity_session_path(p))
        .collect();
    newest(descriptors, |item| {
        cwd.is_empty()
            || item
                .session
                .cwd
                .as_deref()
                .is_some_and(|c| !c.is_empty() && same_directory(c, cwd))
    })
}

/// The newest session run in exactly `cwd`.
pub fn find_antigravity_session_for_cwd(cwd: &str, root: &Path) -> Option<AntigravityDescriptor> {
    if cwd.is_empty() {
        return None;
    }
    let paths = db_files(root, |_| true)?;
    let descriptors = paths
        .iter()
        .filter_map(|p| describe_antigravity_session_path(p))
        .collect();
    newest(descriptors, |item| {
        item.session
            .cwd
            .as_deref()
            .is_some_and(|c| !c.is_empty() && same_directory(c, cwd))
    })
}

/// `parseInt(text, 10)`.
fn parse_int(text: &str) -> f64 {
    let text = js::trim_start(text);
    let (sign, rest) = match text.as_bytes().first() {
        Some(b'-') => (-1.0, &text[1..]),
        Some(b'+') => (1.0, &text[1..]),
        _ => (1.0, text),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    sign * js::number_from_text(&digits)
}

fn finite(value: f64) -> Option<f64> {
    value.is_finite().then_some(value)
}

struct StepRow {
    idx: Option<f64>,
    step_type: Option<f64>,
    metadata: Option<Vec<u8>>,
    payload: Option<Vec<u8>>,
}

fn number_column(value: ValueRef<'_>) -> Option<f64> {
    match value {
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Real(r) => Some(r),
        _ => None,
    }
}

/// The rows of a table as `SELECT *` gives them, by column name.
fn rows_by_name(db: &Connection, sql: &str) -> rusqlite::Result<Vec<Vec<(String, SqlValue)>>> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(|n| (*n).to_owned()).collect();
    let mut rows = statement.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut columns = Vec::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            columns.push((name.clone(), row.get::<_, SqlValue>(i)?));
        }
        out.push(columns);
    }
    Ok(out)
}

fn column<'a>(row: &'a [(String, SqlValue)], name: &str) -> Option<ValueRef<'a>> {
    row.iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| ValueRef::from(v))
}

fn step_record(
    step: &StepRow,
    model: Option<&str>,
    usage_by_step: &[(f64, Obj)],
) -> Option<Vec<Obj>> {
    let meta = decode_proto(step.metadata.as_deref());
    let payload = decode_proto(step.payload.as_deref());
    let mut ms = 0.0;
    if let Some(ts) = find(&meta, 1)
        && ts.val.truthy()
        && let Some(sec) = find(&sub(ts), 1)
    {
        ms = sec.val.number() * 1000.0;
    }
    // An invalid date throws in toISOString: the step is skipped.
    let timestamp = js::try_iso(ms)?;
    let model = model.map(str::to_owned);

    if let Some(f4) = find(&meta, 4)
        && f4.val.truthy()
    {
        let fields = sub(f4);
        let id = find(&fields, 1).map_or_else(
            || format!("call_{}", js::number_text(step.idx.unwrap_or(f64::NAN))),
            |f| to_utf8_string(&f.val),
        );
        let name = find(&fields, 2).map_or_else(|| "tool".to_owned(), |f| to_utf8_string(&f.val));
        let raw = find(&fields, 3).map_or_else(|| "{}".to_owned(), |f| to_utf8_string(&f.val));
        let arguments = match js::parse(&raw) {
            Some(parsed @ Value::Object(_)) => parsed,
            Some(parsed) => Value::Object(obj! { "value" => parsed }),
            None => Value::Object(obj! { "value" => raw.clone() }),
        };
        let mut records = vec![obj! {
            "type" => "assistant",
            "timestamp" => timestamp.clone(),
            "tool_calls" => vec![Value::Object(obj! { "id" => id.clone(), "name" => name.clone(), "arguments" => arguments })],
            "model" => model,
        }];
        if let Some(f140) = find(&payload, 140)
            && f140.val.truthy()
        {
            let result = sub(f140);
            let out = find(&result, 2)
                .map_or_else(String::new, |f| extract_tool_output_text(Some(&f.val)));
            records.push(obj! {
                "type" => "tool_result",
                "timestamp" => timestamp,
                "tool_call_id" => id,
                "tool_name" => name,
                "content" => out,
            });
        }
        return Some(records);
    }

    let step_type = step.step_type.unwrap_or(f64::NAN);
    let mut records = Vec::new();
    if step_type == 14.0 {
        if let Some(f19) = find(&payload, 19)
            && f19.val.truthy()
            && let Some(f2) = find(&sub(f19), 2)
            && f2.val.truthy()
        {
            records.push(obj! {
                "type" => "user",
                "timestamp" => timestamp,
                "content" => js::trim(&to_utf8_string(&f2.val)).to_owned(),
            });
        }
    } else if step_type == 15.0 {
        if let Some(f20) = find(&payload, 20)
            && f20.val.truthy()
        {
            let fields = sub(f20);
            let text = find(&fields, 1)
                .or_else(|| find(&fields, 8))
                .filter(|f| f.val.truthy())
                .map_or_else(String::new, |f| {
                    js::trim(&to_utf8_string(&f.val)).to_owned()
                });
            let thought = find(&fields, 3)
                .filter(|f| f.val.truthy())
                .map_or_else(String::new, |f| {
                    js::trim(&to_utf8_string(&f.val)).to_owned()
                });
            let usage = step
                .idx
                .and_then(|idx| usage_by_step.iter().rev().find(|(at, _)| *at == idx))
                .map(|(_, usage)| usage.clone());
            if !text.is_empty() {
                records.push(obj! {
                    "type" => "assistant",
                    "timestamp" => timestamp,
                    "content" => text,
                    "reasoning" => js::truthy(&thought).map(str::to_owned),
                    "usage" => usage,
                    "model" => model,
                });
            } else if !thought.is_empty() {
                records.push(obj! {
                    "type" => "reasoning",
                    "timestamp" => timestamp,
                    "summary" => thought,
                    "usage" => usage,
                    "model" => model,
                });
            }
        }
    } else if step_type == 101.0 {
        if let Some(f114) = find(&payload, 114)
            && f114.val.truthy()
        {
            records.push(obj! {
                "type" => "system",
                "timestamp" => timestamp,
                "content" => js::trim(&to_utf8_string(&f114.val)).to_owned(),
            });
        }
    } else if step_type == 17.0
        && let Some(f24) = find(&payload, 24)
        && f24.val.truthy()
    {
        let error = js::trim(&to_utf8_string(&f24.val)).to_owned();
        records.push(obj! {
            "type" => "assistant",
            "timestamp" => timestamp,
            "content" => format!("Error: {error}"),
            "error_message" => error,
            "is_error" => true,
        });
    }
    Some(records)
}

/// The usage a gen_metadata row gives the step it names.
fn gen_usage(data: Option<&[u8]>, model: &mut Option<String>) -> Option<(f64, Obj)> {
    let fields = decode_proto(data);
    let f1 = find(&fields, 1)?;
    let inner = sub(f1);
    if let Some(f19) = find(&inner, 19) {
        *model = Some(to_utf8_string(&f19.val));
    }
    let f4 = find(&inner, 4)?;
    let tokens = sub(f4);
    let count = |n: i64| finite(find(&tokens, n).map_or(f64::NAN, |f| f.val.number()));
    let (input, output, cached) = (count(2), count(3), count(9));
    let total = input.unwrap_or(0.0) + output.unwrap_or(0.0);
    let usage = obj! {
        "input_tokens" => input,
        "output_tokens" => output,
        "cached_input_tokens" => cached,
        "total_tokens" => (total != 0.0 && !total.is_nan()).then_some(total),
    };
    let mut last_step = None;
    for kv in inner.iter().filter(|f| f.field == 20) {
        let pair = sub(kv);
        if let (Some(k), Some(v)) = (find(&pair, 1), find(&pair, 2))
            && to_utf8_string(&k.val) == "last_step_index"
        {
            last_step = Some(parse_int(&to_utf8_string(&v.val)));
        }
    }
    last_step.map(|step| (step, usage))
}

/// A session's records, empty when the database cannot be read.
pub fn read_antigravity_session_records(db_path: &str) -> Vec<Obj> {
    with_temp_db(Path::new(db_path), |db| {
        let mut model: Option<String> = None;
        let mut usage_by_step: Vec<(f64, Obj)> = Vec::new();
        if let Ok(rows) = rows_by_name(db, "SELECT * FROM gen_metadata ORDER BY idx ASC") {
            for row in rows {
                let data = column(&row, "data").and_then(blob_column);
                if let Some(entry) = gen_usage(data.as_deref(), &mut model) {
                    usage_by_step.push(entry);
                }
            }
        }
        let Ok(rows) = rows_by_name(db, "SELECT * FROM steps ORDER BY idx ASC") else {
            return Vec::new();
        };
        let steps: Vec<StepRow> = rows
            .iter()
            .map(|row| StepRow {
                idx: column(row, "idx").and_then(number_column),
                step_type: column(row, "step_type").and_then(number_column),
                metadata: column(row, "metadata").and_then(blob_column),
                payload: column(row, "step_payload").and_then(blob_column),
            })
            .collect();
        steps
            .iter()
            .filter_map(|step| step_record(step, model.as_deref(), &usage_by_step))
            .flatten()
            .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn varint(mut n: u64) -> Vec<u8> {
        let mut out = Vec::new();
        while n >= 0x80 {
            out.push((n & 0x7f) as u8 | 0x80);
            n >>= 7;
        }
        out.push(n as u8);
        out
    }

    fn field_varint(field: u64, value: u64) -> Vec<u8> {
        let mut out = varint(field << 3);
        out.extend(varint(value));
        out
    }

    fn field_bytes(field: u64, data: &[u8]) -> Vec<u8> {
        let mut out = varint((field << 3) | 2);
        out.extend(varint(data.len() as u64));
        out.extend_from_slice(data);
        out
    }

    fn step_meta(sec: u64, tool: Option<(&str, &str, &str)>) -> Vec<u8> {
        let mut out = field_bytes(1, &field_varint(1, sec));
        if let Some((id, name, args)) = tool {
            let mut call = field_bytes(1, id.as_bytes());
            call.extend(field_bytes(2, name.as_bytes()));
            call.extend(field_bytes(3, args.as_bytes()));
            out.extend(field_bytes(4, &call));
        }
        out
    }

    const SCHEMA: &str = "CREATE TABLE trajectory_meta (trajectory_id text, cascade_id text, trajectory_type integer, source integer, PRIMARY KEY (trajectory_id));
        CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
        CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx));
        CREATE TABLE trajectory_metadata_blob (id text DEFAULT 'main', data blob, PRIMARY KEY (id));";

    fn insert_step(db: &Connection, idx: i64, step_type: i64, metadata: &[u8], payload: &[u8]) {
        db.execute(
            "INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, ?, ?, ?)",
            rusqlite::params![idx, step_type, metadata, payload],
        )
        .unwrap();
    }

    pub(crate) fn synthetic_db(
        root: &Path,
        session: &str,
        cwd: &str,
        base: u64,
        model: &str,
    ) -> PathBuf {
        std::fs::create_dir_all(root).unwrap();
        let path = root.join(format!("{session}.db"));
        let db = Connection::open(&path).unwrap();
        db.execute_batch(SCHEMA).unwrap();
        db.execute(
            "INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)",
            rusqlite::params![format!("traj-{session}"), session, 4, 17],
        )
        .unwrap();
        db.execute(
            "INSERT INTO trajectory_metadata_blob VALUES (?, ?)",
            rusqlite::params!["main", field_bytes(7, format!("file://{cwd}").as_bytes())],
        )
        .unwrap();
        insert_step(
            &db,
            0,
            14,
            &step_meta(base, None),
            &field_bytes(19, &field_bytes(2, b"Fix the bug in pult")),
        );
        let tool_out = field_bytes(
            140,
            &field_bytes(2, &field_bytes(1, b"Pult documentation content")),
        );
        insert_step(
            &db,
            1,
            132,
            &step_meta(
                base + 5,
                Some((
                    "call_1",
                    "view_file",
                    r#"{"AbsolutePath":"/dev/pult/README.md"}"#,
                )),
            ),
            &tool_out,
        );
        let mut planner = field_bytes(1, b"Bug is fixed!");
        planner.extend(field_bytes(3, b"I checked the documentation."));
        insert_step(
            &db,
            2,
            15,
            &step_meta(base + 10, None),
            &field_bytes(20, &planner),
        );
        let mut tokens = field_varint(2, 150);
        tokens.extend(field_varint(3, 45));
        tokens.extend(field_varint(9, 30));
        let mut kv = field_bytes(1, b"last_step_index");
        kv.extend(field_bytes(2, b"2"));
        let mut gen_payload = field_bytes(19, model.as_bytes());
        gen_payload.extend(field_bytes(4, &tokens));
        gen_payload.extend(field_bytes(20, &kv));
        db.execute(
            "INSERT INTO gen_metadata (idx, data) VALUES (?, ?)",
            rusqlite::params![0, field_bytes(1, &gen_payload)],
        )
        .unwrap();
        path
    }

    #[test]
    fn finds_the_newest_antigravity_session_for_the_exact_working_directory() {
        let root = tempfile::tempdir().unwrap();
        synthetic_db(
            root.path(),
            "older-session",
            "/workspace/repo",
            1726270000,
            "gemini-3.8-flash",
        );
        synthetic_db(
            root.path(),
            "newer-session",
            "/workspace/repo",
            1726280000,
            "gemini-3.8-flash",
        );
        synthetic_db(
            root.path(),
            "other-session",
            "/workspace/other",
            1726290000,
            "gemini-3.8-flash",
        );
        let found = find_antigravity_session_for_cwd("/workspace/repo", root.path()).unwrap();
        assert_eq!(found.session.session_id, "newer-session");
        assert_eq!(
            found.session.model_name.as_deref(),
            Some("gemini-3.8-flash")
        );
        assert!(found.file.path.ends_with("newer-session.db"));
    }

    #[test]
    fn resolves_a_known_session_id_with_exact_name_and_prefix() {
        let root = tempfile::tempdir().unwrap();
        let id = "3f74fcbe-9742-499a-9697-b6a0ef3e2dc2";
        synthetic_db(root.path(), id, "/workspace/repo", 1726272000, "m");
        let exact = find_antigravity_session_by_id(id, "", root.path()).unwrap();
        assert_eq!(exact.session.session_id, id);
        assert_eq!(exact.session.cwd.as_deref(), Some("/workspace/repo"));
        let with_ext =
            find_antigravity_session_by_id(&format!("{id}.db"), "", root.path()).unwrap();
        assert_eq!(with_ext.session.session_id, id);
        let prefix = find_antigravity_session_by_id("3f74fcbe", "", root.path()).unwrap();
        assert_eq!(prefix.session.session_id, id);
        assert!(find_antigravity_session_by_id("../3f74fcbe", "", root.path()).is_none());
    }

    #[test]
    fn describes_session_path_correctly_and_reads_metadata() {
        let root = tempfile::tempdir().unwrap();
        let path = synthetic_db(
            root.path(),
            "session-desc-1",
            "/workspace/my-project",
            1726272000,
            "gemini-3.8-flash",
        );
        let desc = describe_antigravity_session_path(&path).unwrap();
        assert_eq!(desc.session.session_id, "session-desc-1");
        assert_eq!(desc.session.cwd.as_deref(), Some("/workspace/my-project"));
        assert_eq!(desc.session.model_name.as_deref(), Some("gemini-3.8-flash"));
        assert_eq!(
            desc.session.agent_version.as_deref(),
            Some("antigravity-cli")
        );
        assert_eq!(desc.session.created_at_ms, Some(1726272000.0 * 1000.0));
        assert_eq!(
            desc.session.updated_at_ms,
            Some((1726272000.0 + 10.0) * 1000.0)
        );
    }

    #[test]
    fn reads_and_normalizes_session_records_from_database() {
        let root = tempfile::tempdir().unwrap();
        let path = synthetic_db(
            root.path(),
            "session-records-1",
            "/workspace/records",
            1726272000,
            "gemini-3.8-flash",
        );
        let records = read_antigravity_session_records(&path.to_string_lossy());
        assert_eq!(records.len(), 4);
        assert_eq!(records[0]["type"], "user");
        assert_eq!(records[0]["content"], "Fix the bug in pult");
        assert_eq!(records[1]["type"], "assistant");
        assert_eq!(
            records[1]["tool_calls"],
            serde_json::json!([{ "id": "call_1", "name": "view_file", "arguments": { "AbsolutePath": "/dev/pult/README.md" } }])
        );
        assert_eq!(records[2]["type"], "tool_result");
        assert_eq!(records[2]["tool_call_id"], "call_1");
        assert_eq!(records[2]["tool_name"], "view_file");
        assert_eq!(records[2]["content"], "Pult documentation content");
        assert_eq!(records[3]["type"], "assistant");
        assert_eq!(records[3]["content"], "Bug is fixed!");
        assert_eq!(records[3]["reasoning"], "I checked the documentation.");
        assert_eq!(records[3]["usage"]["input_tokens"], 150);
        assert_eq!(records[3]["usage"]["output_tokens"], 45);
        assert_eq!(records[3]["usage"]["cached_input_tokens"], 30);
        assert_eq!(records[3]["usage"]["total_tokens"], 195);
    }

    #[test]
    fn extracts_nested_tool_result_protobuf_and_ensures_content_has_no_control_characters() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("nested-tool-result.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(SCHEMA).unwrap();
        let text = "File Path: /dev/pult\nLine 1\tTabbed\u{0}\u{8}\u{b}\u{c}\u{1f}\u{fffd}Clean";
        let mut nested = field_bytes(1, text.as_bytes());
        nested.extend(field_bytes(
            6,
            &[0x08, 0x01, 0x12, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f],
        ));
        let payload = field_bytes(140, &field_bytes(2, &nested));
        insert_step(
            &db,
            0,
            132,
            &step_meta(
                1726272000,
                Some(("call_nested", "run_command", r#"{"CommandLine":"ls"}"#)),
            ),
            &payload,
        );
        drop(db);
        let records = read_antigravity_session_records(&path.to_string_lossy());
        assert_eq!(records.len(), 2);
        let result = records.iter().find(|r| r["type"] == "tool_result").unwrap();
        assert_eq!(
            result["content"],
            "File Path: /dev/pult\nLine 1\tTabbedClean"
        );
        assert!(!CONTROL.is_match(result["content"].as_str().unwrap()));
    }

    #[test]
    fn fails_soft_with_empty_history_on_unknown_tables_or_future_schema_bump() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("unknown-schema-session.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE schema_v99_future (id text, unknown_payload blob)")
            .unwrap();
        db.execute(
            "INSERT INTO schema_v99_future VALUES (?, ?)",
            rusqlite::params!["fut-1", vec![1u8, 2, 3]],
        )
        .unwrap();
        drop(db);
        let desc = describe_antigravity_session_path(&path).unwrap();
        assert_eq!(desc.session.session_id, "unknown-schema-session");
        let records = read_antigravity_session_records(&path.to_string_lossy());
        assert!(records.is_empty());
        let trajectory = crate::trajectory::project_agent_trajectory("agy", &desc.file, &records);
        assert_eq!(trajectory["schema_version"], "ATIF-v1.7");
        assert_eq!(trajectory["agent"]["name"], "antigravity-cli");
        assert_eq!(trajectory["steps"], serde_json::json!([]));
    }

    #[test]
    fn fails_soft_with_empty_records_when_steps_table_schema_is_altered() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("altered-steps-session.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE steps (step_id text, different_structure text)")
            .unwrap();
        db.execute(
            "INSERT INTO steps VALUES (?, ?)",
            rusqlite::params!["1", "not-expected-columns"],
        )
        .unwrap();
        drop(db);
        assert!(read_antigravity_session_records(&path.to_string_lossy()).is_empty());
    }

    #[test]
    fn fails_soft_on_individual_malformed_step_rows_while_recovering_valid_ones() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("partial-malformed.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(SCHEMA).unwrap();
        insert_step(
            &db,
            0,
            14,
            &step_meta(1726272000, None),
            &field_bytes(19, &field_bytes(2, b"Hello from valid step")),
        );
        insert_step(&db, 1, 15, &[0xff, 0xff, 0xff], &[0xff, 0xff, 0xff]);
        drop(db);
        let records = read_antigravity_session_records(&path.to_string_lossy());
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["type"], "user");
        assert_eq!(records[0]["content"], "Hello from valid step");
    }

    #[test]
    fn fails_soft_with_empty_records_when_file_is_corrupt_or_not_an_sqlite_database() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("not-a-db.db");
        std::fs::write(&path, "this is not an sqlite database at all").unwrap();
        assert!(read_antigravity_session_records(&path.to_string_lossy()).is_empty());
    }
}
