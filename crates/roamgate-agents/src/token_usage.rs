//! `token-usage.ts`: token counts as each agent writes them.

use std::collections::HashMap;

use serde_json::Value;

use crate::js::{self, Obj, num};

/// Token counts; `Some(None)` is an explicit null (unknown).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TokenUsage {
    pub input_tokens: Option<f64>,
    pub cached_input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub reasoning_output_tokens: Option<f64>,
    pub prompt_tokens: Option<Option<f64>>,
    pub total_tokens: Option<Option<f64>>,
}

impl TokenUsage {
    fn any(&self) -> bool {
        self.input_tokens.is_some()
            || self.cached_input_tokens.is_some()
            || self.output_tokens.is_some()
            || self.reasoning_output_tokens.is_some()
            || self.prompt_tokens.is_some()
            || self.total_tokens.is_some()
    }

    pub fn to_value(&self) -> Value {
        let mut map = Obj::new();
        let opt = |v: Option<f64>| v.map(js::number);
        js::put(&mut map, "input_tokens", opt(self.input_tokens));
        js::put(
            &mut map,
            "cached_input_tokens",
            opt(self.cached_input_tokens),
        );
        js::put(&mut map, "output_tokens", opt(self.output_tokens));
        js::put(
            &mut map,
            "reasoning_output_tokens",
            opt(self.reasoning_output_tokens),
        );
        if let Some(prompt) = self.prompt_tokens {
            map.insert(
                "prompt_tokens".into(),
                prompt.map_or(Value::Null, js::number),
            );
        }
        if let Some(total) = self.total_tokens {
            map.insert("total_tokens".into(), total.map_or(Value::Null, js::number));
        }
        Value::Object(map)
    }
}

fn first(values: &[Option<f64>]) -> Option<f64> {
    values.iter().find_map(|v| *v)
}

pub fn token_usage_from(value: Option<&Value>) -> Option<TokenUsage> {
    let value = js::rec(value)?;
    let n = |key: &str| num(value.get(key));
    let pi_input = n("input");
    let pi_cache_write = n("cacheWrite");
    let kimi_input = n("inputOther").or(n("input_other"));
    let kimi_cache_creation = n("inputCacheCreation").or(n("input_cache_creation"));
    let kimi_cached = n("inputCacheRead").or(n("input_cache_read"));
    let kimi_output = n("output");
    let pi_sum = (pi_input.is_some() || pi_cache_write.is_some())
        .then(|| pi_input.unwrap_or(0.0) + pi_cache_write.unwrap_or(0.0));
    let kimi_sum = (kimi_input.is_some() || kimi_cache_creation.is_some())
        .then(|| kimi_input.unwrap_or(0.0) + kimi_cache_creation.unwrap_or(0.0));
    let usage = TokenUsage {
        input_tokens: first(&[
            n("input_tokens"),
            n("inputTokens"),
            n("prompt_tokens"),
            n("promptTokens"),
            pi_sum,
            kimi_sum,
        ]),
        cached_input_tokens: first(&[
            n("cached_input_tokens"),
            n("cache_read_input_tokens"),
            n("cacheReadInputTokens"),
            n("cacheRead"),
            kimi_cached,
        ]),
        output_tokens: first(&[
            n("output_tokens"),
            n("outputTokens"),
            n("completion_tokens"),
            n("completionTokens"),
            kimi_output,
        ]),
        reasoning_output_tokens: first(&[
            n("reasoning_output_tokens"),
            n("reasoningOutputTokens"),
            n("reasoning"),
        ]),
        prompt_tokens: None,
        total_tokens: first(&[n("total_tokens"), n("totalTokens"), n("tokens")]).map(Some),
    };
    usage.any().then_some(usage)
}

fn add_count(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    if a.is_none() && b.is_none() {
        None
    } else {
        Some(a.unwrap_or(0.0) + b.unwrap_or(0.0))
    }
}

fn add_usage(a: &TokenUsage, b: &TokenUsage) -> TokenUsage {
    let prompt = if a.prompt_tokens.is_some() || b.prompt_tokens.is_some() {
        Some(
            if a.prompt_tokens == Some(None) || b.prompt_tokens == Some(None) {
                None
            } else {
                Some(
                    a.prompt_tokens.flatten().unwrap_or(0.0)
                        + b.prompt_tokens.flatten().unwrap_or(0.0),
                )
            },
        )
    } else {
        None
    };
    // total_tokens: null wins; else the sum (undefined when both are).
    let total = if a.total_tokens == Some(None) || b.total_tokens == Some(None) {
        Some(None)
    } else {
        add_count(a.total_tokens.flatten(), b.total_tokens.flatten()).map(Some)
    };
    TokenUsage {
        input_tokens: add_count(a.input_tokens, b.input_tokens),
        cached_input_tokens: add_count(a.cached_input_tokens, b.cached_input_tokens),
        output_tokens: add_count(a.output_tokens, b.output_tokens),
        reasoning_output_tokens: add_count(a.reasoning_output_tokens, b.reasoning_output_tokens),
        prompt_tokens: prompt,
        total_tokens: total,
    }
}

/// The ATIF metrics of a usage, or None.
pub fn token_usage_to_metrics(usage: Option<&TokenUsage>) -> Option<Obj> {
    let usage = usage?;
    let mut metrics = Obj::new();
    let prompt = match usage.prompt_tokens {
        None => usage.input_tokens,
        Some(prompt) => prompt,
    };
    js::put(&mut metrics, "prompt_tokens", prompt);
    js::put(&mut metrics, "completion_tokens", usage.output_tokens);
    js::put(&mut metrics, "cached_tokens", usage.cached_input_tokens);
    let mut extra = Obj::new();
    js::put(
        &mut extra,
        "reasoning_output_tokens",
        usage.reasoning_output_tokens,
    );
    if let Some(Some(total)) = usage.total_tokens {
        js::put(&mut extra, "total_tokens", total);
    }
    if usage.prompt_tokens.is_some() && usage.input_tokens.is_some() {
        js::put(&mut extra, "raw_input_tokens", usage.input_tokens);
    }
    if !extra.is_empty() {
        metrics.insert("extra".into(), Value::Object(extra));
    }
    (!metrics.is_empty()).then_some(metrics)
}

/// A record's usage, and whether it is a running total.
pub fn token_usage_for_record(record: &Obj, muse_provider: &str) -> (Option<TokenUsage>, bool) {
    let payload = js::rec(record.get("payload"));
    if js::sv(record.get("type")) == "event_msg"
        && let Some(payload) = payload
        && js::sv(payload.get("type")) == "token_count"
        && let Some(info) = js::rec(payload.get("info"))
    {
        return (token_usage_from(info.get("total_token_usage")), true);
    }
    if js::sv(record.get("payload_type")) == "runtime.session" {
        let empty = Obj::new();
        let payload = payload.unwrap_or(&empty);
        let event = js::rec(payload.get("event")).unwrap_or(&empty);
        let Some(usage_in) = js::rec(event.get("usage")) else {
            return (None, false);
        };
        if js::sv(payload.get("kind")) != "run" || js::sv(event.get("kind")) != "model_completed" {
            return (None, false);
        }
        let mut merged = usage_in.clone();
        let cached = match usage_in.get("cached_tokens") {
            None | Some(Value::Null) => usage_in.get("cache_read_tokens").cloned(),
            other => other.cloned(),
        };
        match cached {
            Some(v) => {
                merged.insert("cached_input_tokens".into(), v);
            }
            None => {
                merged.shift_remove("cached_input_tokens");
            }
        }
        match usage_in.get("reasoning_tokens") {
            Some(v) => {
                merged.insert("reasoning_output_tokens".into(), v.clone());
            }
            None => {
                merged.shift_remove("reasoning_output_tokens");
            }
        }
        let mut usage = token_usage_from(Some(&Value::Object(merged)));
        if let Some(u) = usage.as_mut() {
            let cached = u.cached_input_tokens.unwrap_or(0.0);
            let known = ["meta", "openai", "echo", "anthropic"].contains(&muse_provider);
            let ambiguous = !known
                && (cached > 0.0 || num(usage_in.get("cache_write_tokens")).unwrap_or(0.0) > 0.0);
            u.prompt_tokens = Some(if ambiguous || u.input_tokens.is_none() {
                None
            } else {
                Some(
                    u.input_tokens.unwrap()
                        + if muse_provider == "anthropic" {
                            cached
                        } else {
                            0.0
                        },
                )
            });
            u.total_tokens = Some(match (u.prompt_tokens, u.output_tokens) {
                (Some(Some(p)), Some(o)) => Some(p + o),
                _ => None,
            });
        }
        return (usage, false);
    }
    let candidates = [
        record.get("usage"),
        js::rec(record.get("message")).and_then(|m| m.get("usage")),
        payload.and_then(|p| p.get("usage")),
    ];
    for candidate in candidates {
        if let Some(usage) = token_usage_from(candidate) {
            return (Some(usage), false);
        }
    }
    (None, false)
}

/// Reads records' usage, knowing each Muse run's provider.
#[derive(Default)]
pub struct TokenUsageReader {
    muse_providers: HashMap<String, String>,
}

impl TokenUsageReader {
    pub fn read(&mut self, record: &Obj) -> (Option<TokenUsage>, bool) {
        let empty = Obj::new();
        let payload = js::rec(record.get("payload")).unwrap_or(&empty);
        if js::sv(record.get("payload_type")) == "run.model.configured"
            && let Some(inner) = js::rec(payload.get("record"))
            && let Some(stream) = js::rec(inner.get("run_stream"))
            && js::sv(stream.get("kind")) == "run"
        {
            self.muse_providers.insert(
                js::sv(stream.get("id")).to_owned(),
                js::sv(inner.get("provider_id")).to_owned(),
            );
        }
        let provider = self
            .muse_providers
            .get(js::sv(payload.get("run_id")))
            .cloned()
            .unwrap_or_default();
        token_usage_for_record(record, &provider)
    }
}

/// A session's usage: its last running total, else the sum.
pub fn summarize_token_usage(records: &[Obj]) -> Option<TokenUsage> {
    let mut reader = TokenUsageReader::default();
    let mut cumulative: Option<TokenUsage> = None;
    let mut summed = TokenUsage::default();
    for record in records {
        let (usage, running) = reader.read(record);
        let Some(usage) = usage else { continue };
        if running {
            cumulative = Some(usage);
        } else {
            summed = add_usage(&summed, &usage);
        }
    }
    cumulative.or_else(|| summed.any().then_some(summed))
}
