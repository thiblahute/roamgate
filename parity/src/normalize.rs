//! The named normalizers of `contract/normalize.json`.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Normalizer {
    Regex {
        pattern: String,
        replace: String,
    },
    Paths {
        replace: BTreeMap<String, String>,
    },
    Drop {
        keys: Vec<String>,
        replace: String,
        #[serde(default)]
        only: Option<String>,
        /// Only in objects with these keys at these values.
        #[serde(default)]
        when: serde_json::Map<String, Value>,
    },
    Sort,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Normalizers {
    pub version: u32,
    #[serde(default)]
    pub description: String,
    pub normalizers: BTreeMap<String, Normalizer>,
}

impl Normalizers {
    pub fn load(contract: &Path) -> Result<Normalizers> {
        let path = contract.join("normalize.json");
        let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
        Ok(serde_json::from_str(&text)?)
    }
}

/// The run's directories for the `paths` normalizers.
#[derive(Debug, Clone, Default)]
pub struct RunPaths {
    pub by_name: BTreeMap<String, String>,
}

fn map_strings(value: &mut Value, apply: &dyn Fn(&str) -> String) {
    match value {
        Value::String(text) => *text = apply(text),
        Value::Array(items) => items.iter_mut().for_each(|item| map_strings(item, apply)),
        // Keys too: a path or an id is often a map's key.
        Value::Object(map) => {
            let entries: Vec<(String, Value)> = std::mem::take(map).into_iter().collect();
            for (key, mut item) in entries {
                map_strings(&mut item, apply);
                map.insert(apply(&key), item);
            }
        }
        _ => {}
    }
}

fn drop_keys(
    value: &mut Value,
    keys: &[String],
    replace: &str,
    only: Option<&str>,
    when: &serde_json::Map<String, Value>,
) {
    match value {
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| drop_keys(item, keys, replace, only, when)),
        Value::Object(map) => {
            let applies = when
                .iter()
                .all(|(key, wanted)| map.get(key) == Some(wanted));
            for (key, item) in map.iter_mut() {
                let kind_ok = match only {
                    Some("number") => item.is_number(),
                    Some("string") => item.is_string(),
                    _ => true,
                };
                if applies && keys.contains(key) && kind_ok {
                    *item = Value::String(replace.to_owned());
                } else {
                    drop_keys(item, keys, replace, only, when);
                }
            }
        }
        _ => {}
    }
}

fn sort_arrays(value: &mut Value) {
    match value {
        Value::Array(items) => {
            items.iter_mut().for_each(sort_arrays);
            items.sort_by_key(|item| item.to_string());
        }
        Value::Object(map) => map.values_mut().for_each(sort_arrays),
        _ => {}
    }
}

impl Normalizers {
    /// `value` with the named normalizers applied, in the order named.
    pub fn apply(&self, names: &[String], value: &Value, paths: &RunPaths) -> Result<Value> {
        let mut out = value.clone();
        for name in names {
            let Some(normalizer) = self.normalizers.get(name) else {
                bail!("unknown normalizer {name} (contract/normalize.json)");
            };
            match normalizer {
                Normalizer::Regex { pattern, replace } => {
                    let regex = Regex::new(pattern)?;
                    map_strings(&mut out, &|text| {
                        regex.replace_all(text, replace.as_str()).into_owned()
                    });
                }
                Normalizer::Paths { replace } => {
                    // Longest path first, so HOME inside ROOT wins.
                    let mut pairs: Vec<(String, String)> = replace
                        .iter()
                        .filter_map(|(key, token)| {
                            paths
                                .by_name
                                .get(key)
                                .map(|path| (path.clone(), token.clone()))
                        })
                        .collect();
                    pairs.sort_by_key(|(path, _)| std::cmp::Reverse(path.len()));
                    map_strings(&mut out, &|text| {
                        let mut text = text.to_owned();
                        for (path, token) in &pairs {
                            text = text.replace(path.as_str(), token);
                        }
                        text
                    });
                }
                Normalizer::Drop {
                    keys,
                    replace,
                    only,
                    when,
                } => drop_keys(&mut out, keys, replace, only.as_deref(), when),
                Normalizer::Sort => sort_arrays(&mut out),
            }
        }
        Ok(out)
    }
}
