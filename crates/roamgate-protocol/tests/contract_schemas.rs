//! The protocol's types held to `contract/schemas` (the Rust migration
//! plan, sections 4.1 and 6.4): each type's JSON Schema, as schemars
//! derives it, is compared with the contract's `$defs` entry of the same
//! name on a normalized projection, and each type's TypeScript
//! declaration exports with ts-rs.
//!
//! The projection keeps what the wire depends on: object property names,
//! which are required, whether other properties are refused, each
//! property's kind (string, number, integer counted as number, boolean,
//! null, arrays by their items, maps by their values, string literal sets,
//! nested objects), and unions of those. References are followed, so a
//! named Rust struct matches an inline TS object. Descriptions, formats and
//! numeric bounds are left out. A property that is not required may be null
//! on one side only: Rust's `Option` left out when `None` is the TS `?:`.
//!
//! Adding a type: one line in `checked!` below.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use roamgate_protocol::{forward, notify, voice};
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Map, Value, json};
use ts_rs::TS;

struct Checked {
    /// The `$defs` name in the contract.
    name: &'static str,
    /// The schema file under contract/schemas.
    file: &'static str,
    schema: fn() -> Value,
    export: fn(&Path) -> Result<(), ts_rs::ExportError>,
    decl: fn() -> String,
}

fn schema_of<T: JsonSchema>() -> Value {
    let mut settings = SchemaSettings::draft2020_12();
    settings.inline_subschemas = true;
    // What the type writes: an `Option` left out when `None` is optional,
    // one always written is a required, nullable property.
    settings.contract = schemars::generate::Contract::Serialize;
    settings.into_generator().root_schema_for::<T>().to_value()
}

macro_rules! checked {
    ($($ty:ty => $name:literal in $file:literal,)*) => {
        vec![$(Checked {
            name: $name,
            file: $file,
            schema: schema_of::<$ty>,
            export: |dir| <$ty as TS>::export_all_to(dir),
            decl: <$ty as TS>::decl,
        },)*]
    };
}

/// Every type of the protocol the contract has a schema for.
fn checked() -> Vec<Checked> {
    checked![
        forward::ForwardWire => "ForwardWire" in "server.schema.json",
        forward::SshForwardDirection => "SshForwardDirection" in "server.schema.json",
        forward::SshForwardState => "SshForwardState" in "server.schema.json",
        notify::TaskEvent => "TaskEvent" in "server.schema.json",
        voice::VoiceEvent => "VoiceEvent" in "server.schema.json",
        voice::VoiceTag => "VoiceTag" in "server.schema.json",
        voice::CallEvent => "CallEvent" in "server.schema.json",
    ]
}

fn schemas_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/schemas")
}

fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Resolves `$ref`s: `#/$defs/X` in the same file, `other.schema.json#/$defs/X`
/// next to it.
struct Resolver {
    root: PathBuf,
}

impl Resolver {
    fn resolve(&self, file: &Path, reference: &str) -> (PathBuf, Value) {
        let (doc_part, pointer) = reference.split_once('#').unwrap_or((reference, ""));
        let target = if doc_part.is_empty() {
            file.to_path_buf()
        } else {
            file.parent().unwrap_or(&self.root).join(doc_part)
        };
        let doc = read_json(&target);
        let value = doc
            .pointer(pointer)
            .unwrap_or_else(|| panic!("{reference} from {}: nowhere", file.display()))
            .clone();
        (target, value)
    }
}

/// The normalized projection of a schema.
fn normalize(schema: &Value, file: &Path, resolver: &Resolver, depth: usize) -> Value {
    assert!(depth < 32, "schema too deep (a recursive type?)");
    let Some(object) = schema.as_object() else {
        return json!({"kind": "any"});
    };
    if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
        let (target, value) = resolver.resolve(file, reference);
        return normalize(&value, &target, resolver, depth + 1);
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(branches) = object.get(key).and_then(Value::as_array) {
            let mut base = object.clone();
            base.remove(key);
            base.remove("description");
            let mut alternatives = Vec::new();
            for branch in branches {
                // Keywords beside anyOf (a `type`) apply to each branch.
                let mut merged = base.clone();
                for (k, v) in branch.as_object().cloned().unwrap_or_default() {
                    merged.insert(k, v);
                }
                alternatives.push(normalize(&Value::Object(merged), file, resolver, depth + 1));
            }
            return union(alternatives);
        }
    }
    if let Some(Value::Array(types)) = object.get("type") {
        let alternatives = types
            .iter()
            .map(|kind| {
                let mut single = object.clone();
                single.insert("type".into(), kind.clone());
                normalize(&Value::Object(single), file, resolver, depth + 1)
            })
            .collect();
        return union(alternatives);
    }
    if let Some(constant) = object.get("const") {
        return json!({"enum": [constant]});
    }
    if let Some(Value::Array(values)) = object.get("enum") {
        let mut values = values.clone();
        values.sort_by_key(|value| value.to_string());
        values.dedup();
        return json!({"enum": values});
    }
    match object.get("type").and_then(Value::as_str) {
        Some("string") => json!({"kind": "string"}),
        Some("number") | Some("integer") => json!({"kind": "number"}),
        Some("boolean") => json!({"kind": "boolean"}),
        Some("null") => json!({"kind": "null"}),
        Some("array") => {
            let items = object.get("items").cloned().unwrap_or(Value::Bool(true));
            json!({"array": normalize(&items, file, resolver, depth + 1)})
        }
        Some("object") | None if object.contains_key("properties") => {
            normalize_object(object, file, resolver, depth)
        }
        Some("object") => match object.get("additionalProperties") {
            Some(values @ Value::Object(_)) => {
                json!({"map": normalize(values, file, resolver, depth + 1)})
            }
            _ => json!({"kind": "object"}),
        },
        _ => json!({"kind": "any"}),
    }
}

fn normalize_object(
    object: &Map<String, Value>,
    file: &Path,
    resolver: &Resolver,
    depth: usize,
) -> Value {
    let required: BTreeSet<String> = object
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|name| name.as_str().map(str::to_owned))
        .collect();
    let mut properties = Map::new();
    let mut names: Vec<&String> = object
        .get("properties")
        .and_then(Value::as_object)
        .map(|props| props.keys().collect())
        .unwrap_or_default();
    names.sort();
    for name in names {
        let schema = &object["properties"][name];
        let mut kind = normalize(schema, file, resolver, depth + 1);
        if !required.contains(name) {
            kind = drop_null(kind);
        }
        properties.insert(name.clone(), kind);
    }
    json!({
        "object": {
            "properties": properties,
            "required": required,
            "closed": object.get("additionalProperties") == Some(&Value::Bool(false)),
        }
    })
}

/// A union, flattened, deduplicated, sorted; string literal sets merged;
/// one alternative is itself.
fn union(alternatives: Vec<Value>) -> Value {
    let mut flat = Vec::new();
    for alternative in alternatives {
        match alternative.get("union").and_then(Value::as_array) {
            Some(inner) => flat.extend(inner.iter().cloned()),
            None => flat.push(alternative),
        }
    }
    let mut literals: Vec<Value> = Vec::new();
    let mut rest: Vec<Value> = Vec::new();
    for alternative in flat {
        match alternative.get("enum").and_then(Value::as_array) {
            Some(values) => literals.extend(values.iter().cloned()),
            None => rest.push(alternative),
        }
    }
    if !literals.is_empty() {
        literals.sort_by_key(|value| value.to_string());
        literals.dedup();
        rest.push(json!({"enum": literals}));
    }
    rest.sort_by_key(|value| value.to_string());
    rest.dedup();
    if rest.len() == 1 {
        rest.pop().unwrap()
    } else {
        json!({"union": rest})
    }
}

fn drop_null(kind: Value) -> Value {
    match kind.get("union").and_then(Value::as_array) {
        Some(alternatives) => union(
            alternatives
                .iter()
                .filter(|alternative| **alternative != json!({"kind": "null"}))
                .cloned()
                .collect(),
        ),
        None => kind,
    }
}

/// The places two projections differ, one line each.
fn diff(path: &str, contract: &Value, rust: &Value, out: &mut Vec<String>) {
    if contract == rust {
        return;
    }
    match (contract, rust) {
        (Value::Object(a), Value::Object(b)) if a.keys().eq(b.keys()) => {
            for (key, value) in a {
                diff(&format!("{path}.{key}"), value, &b[key], out);
            }
        }
        (Value::Object(a), Value::Object(b)) if path.ends_with(".properties") => {
            for key in a.keys().filter(|key| !b.contains_key(*key)) {
                out.push(format!("{path}.{key}: in the contract, not in Rust"));
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                out.push(format!("{path}.{key}: in Rust, not in the contract"));
            }
            for (key, value) in a.iter().filter(|(key, _)| b.contains_key(*key)) {
                diff(&format!("{path}.{key}"), value, &b[key], out);
            }
        }
        _ => out.push(format!("{path}: contract {contract}, Rust {rust}")),
    }
}

fn check(entry: &Checked) -> Vec<String> {
    let resolver = Resolver {
        root: schemas_dir(),
    };
    let file = schemas_dir().join(entry.file);
    let doc = read_json(&file);
    let Some(definition) = doc.pointer(&format!("/$defs/{}", entry.name)) else {
        return vec![format!(
            "{}: no $defs/{} in {}",
            entry.name, entry.name, entry.file
        )];
    };
    let contract = normalize(definition, &file, &resolver, 0);
    let rust = normalize(&(entry.schema)(), &file, &resolver, 0);
    let mut out = Vec::new();
    diff(entry.name, &contract, &rust, &mut out);
    out
}

#[test]
fn every_protocol_type_matches_its_contract_schema() {
    let entries = checked();
    let names: BTreeSet<_> = entries.iter().map(|entry| entry.name).collect();
    assert_eq!(names.len(), entries.len(), "a type is listed twice");
    let problems: Vec<String> = entries.iter().flat_map(check).collect();
    assert!(
        problems.is_empty(),
        "protocol types differ from contract/schemas:\n{}",
        problems.join("\n")
    );
}

#[test]
fn the_check_reports_what_differs() {
    let resolver = Resolver {
        root: schemas_dir(),
    };
    let file = schemas_dir().join("server.schema.json");
    let contract = json!({
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "number"}, "c": {"type": "string", "enum": ["x", "y"]}},
        "required": ["a"],
        "additionalProperties": false
    });
    let rust = json!({
        "type": "object",
        "properties": {
            "a": {"type": "string"},
            "b": {"type": ["integer", "null"], "format": "uint32"},
            "c": {"oneOf": [{"type": "string", "const": "x"}, {"type": "string", "const": "z"}]},
            "d": {"type": "boolean"}
        },
        "required": ["a", "d"]
    });
    let mut out = Vec::new();
    diff(
        "T",
        &normalize(&contract, &file, &resolver, 0),
        &normalize(&rust, &file, &resolver, 0),
        &mut out,
    );
    assert_eq!(
        out,
        vec![
            "T.object.properties.d: in Rust, not in the contract",
            r#"T.object.properties.c.enum: contract ["x","y"], Rust ["x","z"]"#,
            r#"T.object.required: contract ["a"], Rust ["a","d"]"#,
            "T.object.closed: contract true, Rust false",
        ]
    );
}

#[test]
fn every_protocol_type_exports_to_typescript() {
    let dir = tempfile::tempdir().unwrap();
    for entry in checked() {
        (entry.export)(dir.path()).unwrap_or_else(|e| panic!("{}: {e}", entry.name));
        let decl = (entry.decl)();
        assert!(decl.contains(entry.name), "{}: {decl}", entry.name);
        let file = dir.path().join(format!("{}.ts", entry.name));
        let text =
            std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        assert!(
            text.contains(&format!("export type {}", entry.name)),
            "{text}"
        );
    }
}
