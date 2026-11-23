//! The record checker in Rust: a contract recording (`rec-*.jsonl`, the
//! format of server/src/contract-record/recorder.ts) checked against
//! `contract/`, as `bun scripts/contract-record.ts check` does, so the suite
//! needs no Bun once the Rust server stands alone.
//!
//! It is the TS checker's port: messages are classified as
//! server/src/contract-record/corpus.ts does; RPC and push entries and the
//! two OpenAPI documents are bundled with their cross-file `$ref`s as
//! contract/record-check.ts does; a message is a `mismatch` when its schema
//! refuses it, a key no schema at its level names is an `unknown-field`, and
//! a message with no schema is `unlisted`. Findings are grouped by kind,
//! surface, name and path. Mismatch details are the validator's own words,
//! which differ from TypeBox's; kinds, names and paths agree (`both` mode of
//! `PARITY_RECORD_CHECK` runs the two and compares them).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::record::{Finding, Report};

fn read_structured(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    if path
        .extension()
        .is_some_and(|extension| extension == "yaml" || extension == "yml")
    {
        let yaml: serde_yaml::Value = serde_yaml::from_str(&text)?;
        Ok(serde_json::to_value(yaml)?)
    } else {
        Ok(serde_json::from_str(&text)?)
    }
}

fn files_under(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|found| found == extension)
        })
        .map(|entry| entry.into_path())
        .collect();
    out.sort();
    out
}

/// Lexical normalisation of `a/b/../c`.
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `relative(from_dir, to)` as Node's path.relative gives it.
fn relative(from_dir: &Path, to: &Path) -> String {
    let from: Vec<_> = from_dir.components().collect();
    let to_parts: Vec<_> = to.components().collect();
    let common = from
        .iter()
        .zip(&to_parts)
        .take_while(|(a, b)| a == b)
        .count();
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_owned(), from.len() - common).collect();
    parts.extend(
        to_parts[common..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// A document with every `$ref` to another file made local: the targets
/// (and theirs) copied into `defs` under a name saying where they come
/// from (contract/record-check.ts `bundle`).
fn bundle(
    document: &Value,
    path: &Path,
    defs: &mut Map<String, Value>,
    local: &dyn Fn(&str) -> String,
) -> Result<Value> {
    let mut files: BTreeMap<PathBuf, Value> = BTreeMap::new();
    let root_dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
    fn visit(
        node: &Value,
        from: &Path,
        path: &Path,
        root_dir: &Path,
        defs: &mut Map<String, Value>,
        files: &mut BTreeMap<PathBuf, Value>,
        local: &dyn Fn(&str) -> String,
    ) -> Result<Value> {
        match node {
            Value::Array(items) => Ok(Value::Array(
                items
                    .iter()
                    .map(|item| visit(item, from, path, root_dir, defs, files, local))
                    .collect::<Result<_>>()?,
            )),
            Value::Object(map) => {
                let mut out = Map::new();
                for (key, value) in map {
                    let Some(reference) = value.as_str().filter(|_| key == "$ref") else {
                        out.insert(
                            key.clone(),
                            visit(value, from, path, root_dir, defs, files, local)?,
                        );
                        continue;
                    };
                    let (file, pointer) = reference.split_once('#').unwrap_or((reference, ""));
                    if file.is_empty() && from == path {
                        out.insert(key.clone(), value.clone());
                        continue;
                    }
                    let target = if file.is_empty() {
                        from.to_path_buf()
                    } else {
                        normalize_path(&from.parent().unwrap_or(Path::new("")).join(file))
                    };
                    let last = pointer.split('/').next_back().unwrap_or("");
                    let name = format!(
                        "{}__{last}",
                        relative(root_dir, &target).replace(['/', '.'], "_")
                    );
                    out.insert(key.clone(), Value::String(local(&name)));
                    if !defs.contains_key(&name) {
                        defs.insert(name.clone(), Value::Bool(true));
                        if !files.contains_key(&target) {
                            files.insert(target.clone(), read_structured(&target)?);
                        }
                        let mut at = files[&target].clone();
                        for part in pointer.split('/').skip(1) {
                            let part = part.replace("~1", "/").replace("~0", "~");
                            at = at.get(&part).cloned().unwrap_or(Value::Null);
                        }
                        let resolved = visit(&at, &target, path, root_dir, defs, files, local)?;
                        defs.insert(name, resolved);
                    }
                }
                Ok(Value::Object(out))
            }
            other => Ok(other.clone()),
        }
    }
    visit(document, path, path, &root_dir, defs, &mut files, local)
}

fn rewrite_refs(schema: &Value) -> Value {
    match schema {
        Value::Array(items) => Value::Array(items.iter().map(rewrite_refs).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| {
                    let value = match (key.as_str(), value.as_str()) {
                        ("$ref", Some(reference)) => Value::String(reference.replacen(
                            "#/components/schemas/",
                            "#/$defs/",
                            1,
                        )),
                        _ => rewrite_refs(value),
                    };
                    (key.clone(), value)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

struct Operation {
    template: Regex,
    method: String,
    operation: Value,
    defs: Map<String, Value>,
}

fn operations(document: &Value) -> Vec<Operation> {
    let defs = rewrite_refs(
        &document
            .pointer("/components/schemas")
            .cloned()
            .unwrap_or(json!({})),
    );
    let defs = defs.as_object().cloned().unwrap_or_default();
    let tail = Regex::new(r"/\{(static|path)\}$").expect("regex");
    let param = Regex::new(r"\{[^}]+\}").expect("regex");
    let mut out = Vec::new();
    for (template, item) in document
        .get("paths")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let rest = tail.is_match(template);
        let body = if rest {
            tail.replace(template, "").into_owned()
        } else {
            template.clone()
        };
        let parts: Vec<String> = param.split(&body).map(regex::escape).collect();
        let pattern = format!(
            "^{}{}$",
            parts.join("[^/]+"),
            if rest { "(?:/.*)?" } else { "" }
        );
        let Ok(template) = Regex::new(&pattern) else {
            continue;
        };
        for (method, operation) in item.as_object().into_iter().flatten() {
            if ["get", "put", "post", "delete", "patch", "head", "options"]
                .contains(&method.as_str())
            {
                out.push(Operation {
                    template: template.clone(),
                    method: method.to_uppercase(),
                    operation: rewrite_refs(operation),
                    defs: defs.clone(),
                });
            }
        }
    }
    out
}

/// One classified message (corpus.ts `Classified`).
#[derive(Debug, Clone)]
pub struct Classified {
    pub surface: String,
    pub name: String,
    pub payload: Value,
    pub error: bool,
    pub request: Option<(String, String, Value)>,
    pub status: Option<u64>,
    pub at: String,
}

/// A path with its variable segments as `{}` (corpus.ts `routeName`).
pub fn route_name(path: &str) -> String {
    let redacted = Regex::new(r"^\[redacted:[0-9a-f]+\]$").expect("regex");
    let number = Regex::new(r"^[0-9]+$").expect("regex");
    let id = Regex::new(r"(?i)^[0-9a-f-]{8,}$").expect("regex");
    let file = Regex::new(r"(?i)\.[a-z0-9]{1,5}$").expect("regex");
    path.split('/')
        .map(|segment| {
            if redacted.is_match(segment)
                || number.is_match(segment)
                || id.is_match(segment)
                || file.is_match(segment)
            {
                "{}".to_owned()
            } else {
                segment.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Classifies recording lines, remembering which method each pending
/// request id is for.
#[derive(Default)]
pub struct Classifier {
    pending: BTreeMap<String, String>,
}

const ENVELOPE_KEYS: [&str; 2] = ["connection_id", "connection_generation"];

fn unwrap_envelope(message: &Value) -> Value {
    match message {
        Value::Object(map) if map.keys().any(|key| ENVELOPE_KEYS.contains(&key.as_str())) => {
            Value::Object(
                map.iter()
                    .filter(|(key, _)| !ENVELOPE_KEYS.contains(&key.as_str()))
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

impl Classifier {
    pub fn classify(&mut self, record: &Value, at: &str) -> Option<Classified> {
        let channel = record.get("ch")?.as_str()?;
        let event = record.get("ev").and_then(Value::as_str).unwrap_or("");
        let message = record.get("msg").cloned().unwrap_or(Value::Null);
        let sock = record.get("sock").and_then(Value::as_str).unwrap_or("");
        let make = |surface: &str, name: String, payload: Value| Classified {
            surface: surface.into(),
            name,
            payload,
            error: false,
            request: None,
            status: None,
            at: at.to_owned(),
        };
        match channel {
            "ws" => match event {
                "in" => {
                    let map = message.as_object()?;
                    if map.contains_key("ack") && map.len() == 1 {
                        return Some(make("ws.ack", "ack".into(), message.clone()));
                    }
                    let method = map
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or("?")
                        .to_owned();
                    if let Some(id) = map.get("id") {
                        let id = id
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| id.to_string());
                        self.pending
                            .insert(format!("{sock}\u{0}{id}"), method.clone());
                    }
                    Some(make(
                        "rpc.request",
                        method,
                        map.get("params").cloned().unwrap_or(json!({})),
                    ))
                }
                "out" => {
                    let unwrapped = unwrap_envelope(&message);
                    let map = unwrapped.as_object()?;
                    if let Some(id) = map.get("id")
                        && (map.contains_key("result") || map.contains_key("error"))
                    {
                        let id = id
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| id.to_string());
                        let method = self
                            .pending
                            .remove(&format!("{sock}\u{0}{id}"))
                            .unwrap_or_else(|| "?".into());
                        let error = map.contains_key("error") && !map.contains_key("result");
                        let payload = if error {
                            map["error"].clone()
                        } else {
                            map.get("result").cloned().unwrap_or(Value::Null)
                        };
                        let mut classified = make("rpc.reply", method, payload);
                        classified.error = error;
                        return Some(classified);
                    }
                    Some(make(
                        "push",
                        crate::ws::push_name(&unwrapped),
                        unwrapped.clone(),
                    ))
                }
                _ => None,
            },
            "http" | "agent" | "mcp" => {
                if event != "exchange" {
                    return None;
                }
                let path = record
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let method = record
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_owned();
                let name = match channel {
                    "agent" => path.trim_start_matches("/v1/").to_owned(),
                    "mcp" => record
                        .pointer("/body/method")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{method} {path}")),
                    _ => format!("{method} {}", route_name(&path)),
                };
                let mut classified = make(
                    channel,
                    name,
                    record.get("response").cloned().unwrap_or(Value::Null),
                );
                if record.get("response").is_none() {
                    classified.payload = Value::Null;
                }
                classified.request = Some((
                    method,
                    path,
                    record.get("body").cloned().unwrap_or(Value::Null),
                ));
                classified.status = record.get("status").and_then(Value::as_u64);
                // A missing response body is `undefined` in TS: not checked.
                if record.get("response").is_none() {
                    classified.payload = json!({"$undefined": true});
                }
                Some(classified)
            }
            _ => None,
        }
    }
}

/// A string the recorder put in place of a secret (redact.ts).
pub fn is_redacted(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.strip_prefix("[redacted:")
            .and_then(|rest| rest.strip_suffix(']'))
            .is_some_and(|hex| {
                !hex.is_empty()
                    && hex
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
    })
}

/// Whether a value is, or holds, a redacted string (an anyOf fails above
/// the redacted leaf).
pub fn holds_redacted(value: &Value) -> bool {
    match value {
        Value::Array(items) => items.iter().any(holds_redacted),
        Value::Object(map) => map.values().any(holds_redacted),
        other => is_redacted(other),
    }
}

fn is_object(value: &Value) -> bool {
    value.is_object()
}

fn resolve_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    let pointer = reference.strip_prefix('#')?;
    root.pointer(pointer)
}

fn branches<'a>(schema: &'a Value, root: &'a Value, depth: usize, out: &mut Vec<&'a Value>) {
    if !is_object(schema) || depth > 16 {
        return;
    }
    out.push(schema);
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str)
        && let Some(target) = resolve_ref(root, reference)
    {
        branches(target, root, depth + 1, out);
    }
    for key in ["allOf", "anyOf", "oneOf"] {
        for branch in schema
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            branches(branch, root, depth + 1, out);
        }
    }
    for key in ["then", "else"] {
        if let Some(branch) = schema.get(key).filter(|value| is_object(value)) {
            branches(branch, root, depth + 1, out);
        }
    }
}

/// Paths of the keys no schema at their level names (check.ts
/// `unknownFields`).
pub fn unknown_fields(
    schema: &Value,
    value: &Value,
    root: &Value,
    path: &str,
    depth: usize,
) -> Vec<String> {
    if depth > 32 || schema == &Value::Bool(true) {
        return Vec::new();
    }
    let mut all = Vec::new();
    branches(schema, root, 0, &mut all);
    let mut out = Vec::new();
    if let Value::Object(map) = value {
        let described: Vec<&Value> = all
            .iter()
            .copied()
            .filter(|branch| {
                branch.get("properties").is_some_and(is_object)
                    || branch.get("patternProperties").is_some_and(is_object)
                    || branch.get("additionalProperties").is_some_and(is_object)
            })
            .collect();
        if described.is_empty() {
            return Vec::new();
        }
        for (key, item) in map {
            let mut children: Vec<&Value> = Vec::new();
            for branch in &described {
                if let Some(child) = branch
                    .get("properties")
                    .and_then(|properties| properties.get(key))
                {
                    children.push(child);
                } else if let Some(patterns) =
                    branch.get("patternProperties").and_then(Value::as_object)
                {
                    for (pattern, child) in patterns {
                        if Regex::new(pattern).is_ok_and(|regex| regex.is_match(key)) {
                            children.push(child);
                        }
                    }
                }
                if children.is_empty()
                    && let Some(additional) = branch
                        .get("additionalProperties")
                        .filter(|value| is_object(value))
                {
                    children.push(additional);
                }
            }
            let at = format!("{path}/{key}");
            if children.is_empty() {
                out.push(at);
                continue;
            }
            // Unknown only where no branch describing the key knows it.
            let sets: Vec<Vec<String>> = children
                .iter()
                .map(|child| unknown_fields(child, item, root, &at, depth + 1))
                .collect();
            for unknown in &sets[0] {
                if sets[1..].iter().all(|set| set.contains(unknown)) {
                    out.push(unknown.clone());
                }
            }
        }
    } else if let Value::Array(values) = value
        && let Some(items) = all
            .iter()
            .filter_map(|branch| branch.get("items"))
            .find(|items| is_object(items))
    {
        for (index, item) in values.iter().take(16).enumerate() {
            out.extend(unknown_fields(
                items,
                item,
                root,
                &format!("{path}/{index}"),
                depth + 1,
            ));
        }
    }
    let index = Regex::new(r"/\d+(/|$)").expect("regex");
    let mut seen = Vec::new();
    for path in out {
        let mut path = path;
        while index.is_match(&path) {
            path = index.replace_all(&path, "/*$1").into_owned();
        }
        if !seen.contains(&path) {
            seen.push(path);
        }
    }
    seen
}

/// The contract's schemas, bundled.
pub struct ContractSchemas {
    rpc: BTreeMap<String, Value>,
    push: BTreeMap<String, Value>,
    http: Vec<Operation>,
    agent: Vec<Operation>,
}

impl ContractSchemas {
    pub fn load(contract: &Path) -> Result<ContractSchemas> {
        let mut rpc = BTreeMap::new();
        let mut push = BTreeMap::new();
        for (dir, into) in [("rpc", &mut rpc), ("push", &mut push)] {
            for file in files_under(&contract.join(dir), "json") {
                let mut defs = Map::new();
                let document = read_structured(&file)?;
                let mut bundled = bundle(&document, &file, &mut defs, &|name| {
                    format!("#/$defs/{name}")
                })?;
                if !defs.is_empty()
                    && let Value::Object(map) = &mut bundled
                {
                    let mut all = map
                        .get("$defs")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    all.extend(defs);
                    map.insert("$defs".into(), Value::Object(all));
                }
                let name = file
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().into_owned())
                    .unwrap_or_default();
                into.insert(name, bundled);
            }
        }
        let openapi = |dir: &str| -> Result<Vec<Operation>> {
            let file = contract.join(dir).join("openapi.yaml");
            if !file.exists() {
                return Ok(Vec::new());
            }
            let mut schemas = Map::new();
            let mut document = bundle(&read_structured(&file)?, &file, &mut schemas, &|name| {
                format!("#/components/schemas/{name}")
            })?;
            if let Value::Object(map) = &mut document {
                let components = map.entry("components").or_insert_with(|| json!({}));
                if let Value::Object(components) = components {
                    let mut all = components
                        .get("schemas")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    all.extend(schemas);
                    components.insert("schemas".into(), Value::Object(all));
                }
            }
            Ok(operations(&document))
        };
        let http = openapi("http")?;
        let agent = openapi("agent-socket")?;
        Ok(ContractSchemas {
            rpc,
            push,
            http,
            agent,
        })
    }

    fn rpc_part(&self, method: &str, part: &str) -> Option<Option<Value>> {
        let document = self.rpc.get(method)?;
        let schema = document
            .get(part)
            .or_else(|| document.pointer(&format!("/$defs/{part}")));
        let Some(schema) = schema else {
            return Some(None);
        };
        let mut schema = schema.clone();
        if let (Some(defs), Value::Object(map)) = (document.get("$defs"), &mut schema)
            && !map.contains_key("$defs")
        {
            map.insert("$defs".into(), defs.clone());
        }
        Some(Some(schema))
    }

    fn validate(
        &self,
        surface: &str,
        name: &str,
        schema: &Value,
        value: &Value,
        at: &str,
        out: &mut Vec<Finding>,
    ) {
        let finding = |kind: &str, path: String, detail: String| Finding {
            kind: kind.into(),
            surface: surface.into(),
            name: name.into(),
            path,
            detail,
            count: 1,
        };
        // An empty schema ({}) accepts everything.
        match jsonschema::validator_for(schema) {
            Ok(validator) => {
                let errors: Vec<_> = validator.iter_errors(value).collect();
                for error in &errors {
                    // The recorder replaced the value (a secret): no schema
                    // can judge it.
                    if holds_redacted(&error.instance) {
                        continue;
                    }
                    out.push(finding(
                        "mismatch",
                        format!("{at}{}", error.instance_path),
                        error.to_string(),
                    ));
                    // TypeBox also names each key additionalProperties
                    // refuses, at its own path.
                    if let jsonschema::error::ValidationErrorKind::AdditionalProperties {
                        unexpected,
                    } = &error.kind
                    {
                        for key in unexpected {
                            out.push(finding(
                                "mismatch",
                                format!("{at}{}/{key}", error.instance_path),
                                "unexpected property".into(),
                            ));
                        }
                    }
                }
            }
            Err(error) => out.push(finding(
                "mismatch",
                at.into(),
                format!("schema does not compile: {error}"),
            )),
        }
        for path in unknown_fields(schema, value, schema, "", 0) {
            out.push(finding(
                "unknown-field",
                format!("{at}{path}"),
                "not in the schema".into(),
            ));
        }
    }

    /// The findings of one message; None when its surface has no contract
    /// home (not counted as checked).
    pub fn check(&self, message: &Classified) -> Option<Vec<Finding>> {
        let mut out = Vec::new();
        let surface = message.surface.as_str();
        let name = message.name.as_str();
        let unlisted = |detail: String| {
            vec![Finding {
                kind: "unlisted".into(),
                surface: surface.into(),
                name: name.into(),
                path: "/".into(),
                detail,
                count: 1,
            }]
        };
        match surface {
            "rpc.request" | "rpc.reply" => {
                let part = if surface == "rpc.request" {
                    "params"
                } else if message.error {
                    "error"
                } else {
                    "reply"
                };
                match self.rpc_part(name, part) {
                    None => Some(unlisted("no contract/rpc entry".into())),
                    Some(None) if part == "error" => Some(Vec::new()),
                    Some(None) => Some(unlisted(format!("no {part} schema"))),
                    Some(Some(schema)) => {
                        self.validate(surface, name, &schema, &message.payload, part, &mut out);
                        Some(out)
                    }
                }
            }
            "push" => {
                let key = name
                    .trim_start_matches("event:")
                    .trim_start_matches("method:");
                let Some(schema) = self.push.get(name).or_else(|| self.push.get(key)) else {
                    return Some(unlisted("no contract/push entry".into()));
                };
                self.validate(surface, name, schema, &message.payload, "message", &mut out);
                Some(out)
            }
            "http" | "agent" => {
                let list = if surface == "http" {
                    &self.http
                } else {
                    &self.agent
                };
                let (method, path, body) = message.request.clone().unwrap_or_default();
                let Some(operation) = list
                    .iter()
                    .find(|op| op.method == method && op.template.is_match(&path))
                else {
                    return Some(unlisted(format!("no operation for {method} {path}")));
                };
                let with_defs = |schema: &Value| {
                    let mut schema = schema.clone();
                    if !operation.defs.is_empty()
                        && let Value::Object(map) = &mut schema
                    {
                        map.insert("$defs".into(), Value::Object(operation.defs.clone()));
                    }
                    schema
                };
                let content = operation
                    .operation
                    .pointer("/requestBody/content")
                    .cloned()
                    .unwrap_or(json!({}));
                let request_schema = content
                    .pointer("/application~1json/schema")
                    .or_else(|| content.pointer("/application~1x-www-form-urlencoded/schema"));
                if let Some(schema) = request_schema
                    && !body.is_null()
                {
                    self.validate(
                        surface,
                        name,
                        &with_defs(schema),
                        &body,
                        "request",
                        &mut out,
                    );
                }
                let responses = operation
                    .operation
                    .get("responses")
                    .cloned()
                    .unwrap_or(json!({}));
                let response = message
                    .status
                    .and_then(|status| {
                        responses
                            .get(status.to_string())
                            .or_else(|| responses.get(format!("{}XX", status / 100)))
                            .cloned()
                    })
                    .or_else(|| responses.get("default").cloned());
                if response.is_none()
                    && let Some(status) = message.status
                {
                    out.push(Finding {
                        kind: "mismatch".into(),
                        surface: surface.into(),
                        name: name.into(),
                        path: "/status".into(),
                        detail: format!("status {status} not described"),
                        count: 1,
                    });
                }
                if let Some(schema) = response
                    .as_ref()
                    .and_then(|response| response.pointer("/content/application~1json/schema"))
                    && message.payload.get("$undefined").is_none()
                {
                    self.validate(
                        surface,
                        name,
                        &with_defs(schema),
                        &message.payload,
                        "response",
                        &mut out,
                    );
                }
                Some(out)
            }
            _ => None,
        }
    }
}

fn recording_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .is_some_and(|name| name.starts_with("rec-") && name.ends_with(".jsonl"))
        })
        .collect();
    files.sort();
    files
}

/// Checks every message of a recording directory.
pub fn check_recordings(dir: &Path, contract: &Path) -> Result<Report> {
    let schemas = ContractSchemas::load(contract)?;
    let mut classifier = Classifier::default();
    let mut grouped: BTreeMap<(String, String, String, String), Finding> = BTreeMap::new();
    let mut order: Vec<(String, String, String, String)> = Vec::new();
    let (mut messages, mut checked) = (0u64, 0u64);
    for file in recording_files(dir) {
        let text = std::fs::read_to_string(&file)?;
        for (number, line) in text.lines().enumerate() {
            if line.is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let at = format!("{}:{}", file.display(), number + 1);
            let Some(message) = classifier.classify(&record, &at) else {
                continue;
            };
            messages += 1;
            let Some(findings) = schemas.check(&message) else {
                continue;
            };
            checked += 1;
            for finding in findings {
                let key = (
                    finding.kind.clone(),
                    finding.surface.clone(),
                    finding.name.clone(),
                    finding.path.clone(),
                );
                match grouped.get_mut(&key) {
                    Some(existing) => existing.count += 1,
                    None => {
                        order.push(key.clone());
                        grouped.insert(key, finding);
                    }
                }
            }
        }
    }
    // Messages the TS classifier knows but checks nothing of (other
    // sockets, CLI, spawns) are counted there too.
    let findings = order
        .into_iter()
        .filter_map(|key| grouped.remove(&key))
        .collect();
    Ok(Report {
        messages,
        checked,
        findings,
    })
}
