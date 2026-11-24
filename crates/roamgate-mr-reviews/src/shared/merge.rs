//! Scheduled merges and merge bots (`shared/mrReviewsMerge.ts`, plan
//! section 15 of the reviews design). Read only: nothing here acts on a
//! forge. Held to `contract/vectors/mr-reviews-merge.json`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use fancy_regex::Regex;
use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

pub const RULE_KEYS: [&str; 4] = ["afterLabels", "bots", "botFailures", "queueLabels"];

/// settings.json's names of the lists.
pub fn stored_key(key: &str) -> &'static str {
    match key {
        "afterLabels" => "after_labels",
        "bots" => "bots",
        "botFailures" => "bot_failures",
        _ => "queue_labels",
    }
}

pub const MAX_MERGE_PATTERNS: usize = 20;
pub const MAX_MERGE_PATTERN: usize = 200;
pub const MAX_MERGE_SCOPES: usize = 50;

/// The four lists in effect for one project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rules {
    pub after_labels: Vec<String>,
    pub bots: Vec<String>,
    pub bot_failures: Vec<String>,
    pub queue_labels: Vec<String>,
}

fn list(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).to_owned()).collect()
}

impl Default for Rules {
    fn default() -> Self {
        Rules {
            after_labels: list(&[
                r"^merge[-_ ]?after\b[\s:=]*(?<delay>.+)$",
                r"^merge[-_ ]?in\b[\s:=]*(?<delay>.+)$",
            ]),
            bots: list(&[
                "marge-bot",
                "marge",
                "bors",
                "bors-ng",
                "mergify",
                "kodiak",
                "kodiakhq",
                "mergebot",
                "merge-bot",
                "github-merge-queue",
            ]),
            bot_failures: list(&[
                r"^I couldn'?t merge this branch:?\s*(?<reason>.*)",
                r"^Sorry,? I can'?t (?<reason>.*)",
                r"^(?<reason>I'm broken on the inside.*)",
                r"(?<reason>refused to merge.*)",
                r"^:?(broken_heart|x):?\s*(?<reason>(build|tests?) failed.*)",
                r"^(?<reason>merge conflict.*)",
                r"(?<reason>removed from the (merge )?queue.*)",
            ]),
            queue_labels: list(&[
                r"^(merge[-_ ]?queue|queued[-_ ]?(for|to)[-_ ]?merge|ready[-_ ]?to[-_ ]?merge[-_ ]?bot)$",
            ]),
        }
    }
}

impl Rules {
    fn slot(&mut self, key: &str) -> &mut Vec<String> {
        match key {
            "afterLabels" => &mut self.after_labels,
            "bots" => &mut self.bots,
            "botFailures" => &mut self.bot_failures,
            _ => &mut self.queue_labels,
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "afterLabels": self.after_labels,
            "bots": self.bots,
            "botFailures": self.bot_failures,
            "queueLabels": self.queue_labels,
        })
    }

    pub fn from_json(value: &Value) -> Rules {
        let mut rules = Rules::default();
        for key in RULE_KEYS {
            if let Some(items) = value.get(key).and_then(Value::as_array) {
                *rules.slot(key) = items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
            }
        }
        rules
    }
}

/// A JavaScript `new RegExp(pattern, "iu")`, or None when it does not compile.
fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(&format!("(?i){pattern}")).ok()
}

/// Compiled patterns, shared: a clone of a `Regex` gets a search cache of
/// its own, built again on its first search.
static CACHE: LazyLock<Mutex<HashMap<String, Option<Arc<Regex>>>>> =
    LazyLock::new(Default::default);

fn regex(pattern: &str) -> Option<Arc<Regex>> {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(found) = cache.get(pattern) {
        return found.clone();
    }
    let found = compile(pattern).map(Arc::new);
    if cache.len() > 500 {
        cache.clear();
    }
    cache.insert(pattern.to_owned(), found.clone());
    found
}

/// A pattern as the settings keep it, or None when it does not compile.
pub fn merge_pattern(text: &Value) -> Option<String> {
    let value = js::trim(text.as_str()?);
    if value.is_empty() || js::len16(value) > MAX_MERGE_PATTERN {
        return None;
    }
    compile(value).map(|_| value.to_owned())
}

/// A bot name as compared: lower case, no `@`, no `[bot]` suffix.
pub fn bot_name(name: &str) -> String {
    let value = js::trim(name);
    let value = value.strip_prefix('@').unwrap_or(value);
    let lower = value.to_lowercase();
    let cut = if lower.ends_with("[bot]") {
        lower.len() - 5
    } else {
        lower.len()
    };
    lower[..cut].to_owned()
}

static SCOPE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9.-]+(:\d+)?(/[\w.-]+)*(/\*)?$").expect("pattern"));

/// A scope key: "host", "host/group/*" or "host/project", lower case.
pub fn merge_scope(text: &Value) -> Option<String> {
    let lower = js::trim(text.as_str()?).to_lowercase();
    let value = lower
        .strip_prefix("http://")
        .or_else(|| lower.strip_prefix("https://"))
        .unwrap_or(&lower);
    let value = value.trim_end_matches('/');
    if value.is_empty() || js::len16(value) > 300 {
        return None;
    }
    SCOPE.is_match(value).then(|| value.to_owned())
}

fn scope_rank(scope: &str, host: &str, project: &str) -> i64 {
    let full = format!("{host}/{project}").to_lowercase();
    if scope == full {
        return 10_000;
    }
    if let Some(prefix) = scope.strip_suffix('*').filter(|_| scope.ends_with("/*")) {
        return if full.starts_with(prefix) {
            js::len16(prefix) as i64
        } else {
            -1
        };
    }
    if scope == host.to_lowercase() { 1 } else { -1 }
}

/// The lists in effect for a project: defaults, the user's, then scopes.
/// `settings` is `MrMergeSettings` (camel-case lists and `scopes`).
pub fn rules_for(settings: Option<&Value>, host: &str, project: &str) -> Rules {
    let mut rules = Rules::default();
    let Some(settings) = settings.filter(|s| s.is_object()) else {
        return rules;
    };
    let apply = |rules: &mut Rules, lists: &Value| {
        for key in RULE_KEYS {
            if let Some(items) = lists.get(key).and_then(Value::as_array) {
                *rules.slot(key) = items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
            }
        }
    };
    apply(&mut rules, settings);
    let mut scopes: Vec<(&Value, i64)> = settings
        .get("scopes")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(scope, lists)| (lists, scope_rank(scope, host, project)))
        .filter(|(_, rank)| *rank >= 0)
        .collect();
    scopes.sort_by_key(|(_, rank)| *rank);
    for (lists, _) in scopes {
        apply(&mut rules, lists);
    }
    rules
}

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;
const WEEK: f64 = 7.0 * DAY;

fn word(text: &str) -> Option<f64> {
    Some(match text {
        "a" | "an" | "one" => 1.0,
        "two" => 2.0,
        "three" => 3.0,
        "four" => 4.0,
        "five" => 5.0,
        "six" => 6.0,
        "seven" => 7.0,
        "eight" => 8.0,
        "nine" => 9.0,
        "ten" => 10.0,
        _ => return None,
    })
}

fn unit(text: &str) -> Option<f64> {
    Some(match text {
        "m" | "min" | "mins" | "minute" | "minutes" => MINUTE,
        "h" | "hr" | "hrs" | "hour" | "hours" => HOUR,
        "d" | "day" | "days" => DAY,
        "w" | "wk" | "wks" | "week" | "weeks" => WEEK,
        _ => return None,
    })
}

static DELAY_PART: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"^\s*(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s*([a-z]+)\s*(?:,|and)?")
        .expect("pattern")
});

/// A delay as labels write it ("2 days", "3d", "1 week 2 days"), in ms.
pub fn parse_merge_delay(text: &str) -> Option<f64> {
    let value: String = js::trim(text)
        .to_lowercase()
        .chars()
        .map(|c| if "()[]\"':".contains(c) { ' ' } else { c })
        .collect();
    if value.is_empty() {
        return None;
    }
    let mut total = 0.0;
    let mut rest: &str = &value;
    let mut matched = 0;
    while !js::trim(rest).is_empty() {
        let captures = DELAY_PART.captures(rest)?;
        let amount_text = &captures[1];
        let amount = if amount_text.starts_with(|c: char| c.is_ascii_digit()) {
            amount_text.parse::<f64>().ok()?
        } else {
            word(amount_text)?
        };
        let size = unit(&captures[2])?;
        if !amount.is_finite() {
            return None;
        }
        total += amount * size;
        matched += 1;
        rest = &rest[captures[0].len()..];
    }
    (matched > 0 && total > 0.0 && total <= 365.0 * DAY).then(|| js_round(total))
}

/// `Math.round`: halves up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A delay as the row says it: "2 days", "1 week", "36 hours".
pub fn format_merge_delay(ms: f64) -> String {
    let plural = |n: f64, word: &str| {
        format!(
            "{} {word}{}",
            js::number_text(n),
            if n == 1.0 { "" } else { "s" }
        )
    };
    if ms % WEEK == 0.0 {
        return plural(ms / WEEK, "week");
    }
    if ms % DAY == 0.0 {
        return plural(ms / DAY, "day");
    }
    if ms % HOUR == 0.0 {
        return plural(ms / HOUR, "hour");
    }
    if ms >= DAY {
        let days = (ms / DAY).floor();
        let hours = js_round((ms % DAY) / HOUR);
        return format!("{} {}", plural(days, "day"), plural(hours, "hour"));
    }
    plural(js_round(ms / MINUTE).max(1.0), "minute")
}

/// The first label scheduling a merge: (label, delay in ms).
pub fn merge_after_label(labels: &[String], patterns: &[String]) -> Option<(String, f64)> {
    for label in labels {
        let trimmed = js::trim(label);
        for pattern in patterns {
            let Some(re) = regex(pattern) else { continue };
            let Ok(Some(captures)) = re.captures(trimmed) else {
                continue;
            };
            let whole = captures.get(0).expect("group 0");
            let text = captures
                .name("delay")
                .or_else(|| captures.get(1))
                .map(|m| m.as_str().to_owned())
                .unwrap_or_else(|| trimmed[whole.end()..].to_owned());
            let delay = if text.is_empty() {
                None
            } else {
                parse_merge_delay(&text)
            };
            if let Some(delay) = delay.filter(|d| *d != 0.0) {
                return Some((label.clone(), delay));
            }
        }
    }
    None
}

/// The label saying the request is queued for a merge bot.
pub fn queue_label(labels: &[String], patterns: &[String]) -> Option<String> {
    labels
        .iter()
        .find(|label| {
            patterns
                .iter()
                .any(|p| regex(p).is_some_and(|re| re.is_match(js::trim(label)).unwrap_or(false)))
        })
        .cloned()
}

static SPACES: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\s+").expect("pattern"));

fn squash(text: &str) -> String {
    js::trim(&SPACES.replace_all(text, " ")).to_owned()
}

/// A bot's note read as a failed attempt: its reason.
pub fn bot_failure_reason(body: &str, patterns: &[String]) -> Option<String> {
    let text = squash(body);
    for pattern in patterns {
        let Some(re) = regex(pattern) else { continue };
        let Ok(Some(captures)) = re.captures(&text) else {
            continue;
        };
        let reason = captures
            .name("reason")
            .map_or(text.as_str(), |m| m.as_str());
        let reason = js::trim(reason);
        let reason = if reason.is_empty() {
            text.as_str()
        } else {
            reason
        };
        return Some(js::head16(reason, 200));
    }
    None
}

fn later_than(a: Option<&str>, b: Option<&str>) -> bool {
    let Some(a) = a.filter(|a| !a.is_empty()) else {
        return false;
    };
    let Some(b) = b.filter(|b| !b.is_empty()) else {
        return true;
    };
    js::date_parse(a) > js::date_parse(b)
}

fn strs(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// The input of [`merge_info`]: `MrMergeInfo`'s parameters.
pub struct MergeInput<'a> {
    pub state: &'a str,
    pub labels: Vec<String>,
    pub updated_at: &'a str,
    /// `MrMergeFacts`.
    pub facts: Option<&'a Value>,
    /// `MrMergeNote[]`.
    pub notes: Vec<Obj>,
    pub rules: &'a Rules,
    pub user: Option<&'a str>,
    pub now: f64,
}

/// A request's merge state (`MrMergeInfo`), or None.
pub fn merge_info(input: &MergeInput) -> Option<Obj> {
    if input.state != "open" {
        return None;
    }
    let mut info = Obj::new();
    let facts = input.facts.filter(|f| f.is_object());
    if let Some((label, delay)) = merge_after_label(&input.labels, &input.rules.after_labels) {
        let added = facts
            .and_then(|f| f.get("labelsAddedAt"))
            .and_then(|l| l.get(&label))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let approved = facts
            .and_then(|f| f.get("approvedAt"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let (from, since) = match (added, approved) {
            (Some(added), _) => ("label", added),
            (None, Some(approved)) => ("approval", approved),
            _ => ("update", input.updated_at),
        };
        let start = js::date_parse(since);
        if start.is_finite() {
            let at = start + delay;
            info.insert(
                "after".into(),
                json!({
                    "label": label,
                    "delayMs": js::number(delay),
                    "delay": format_merge_delay(delay),
                    "from": from,
                    "since": since,
                    "at": js::iso(at),
                    "ready": input.now >= at,
                }),
            );
        }
    }
    if let Some(bot) = merge_bot(input, facts) {
        info.insert("bot".into(), Value::Object(bot));
    }
    (!info.is_empty()).then_some(info)
}

struct Failure {
    reason: String,
    at: String,
    name: String,
    via: &'static str,
}

fn merge_bot(input: &MergeInput, facts: Option<&Value>) -> Option<Obj> {
    let bots: Vec<String> = input.rules.bots.iter().map(|b| bot_name(b)).collect();
    let is_bot =
        |name: Option<&str>| name.is_some_and(|n| !n.is_empty() && bots.contains(&bot_name(n)));
    let me = input.user.map(bot_name).unwrap_or_default();
    let events: Vec<&Value> = facts
        .and_then(|f| f.get("events"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .collect();
    let assignee = strs(facts.and_then(|f| f.get("assignees")))
        .into_iter()
        .find(|n| is_bot(Some(n)));
    let reviewer = strs(facts.and_then(|f| f.get("reviewers")))
        .into_iter()
        .find(|n| is_bot(Some(n)));
    let label = queue_label(&input.labels, &input.rules.queue_labels);
    let queue = facts.and_then(|f| f.get("queue")).filter(|q| q.is_object());
    let auto_merge = facts
        .and_then(|f| f.get("autoMerge"))
        .filter(|q| q.is_object());
    let mut current: Option<Obj> = None;
    let make = |name: &str, via: &str| {
        let mut o = Obj::new();
        o.insert("name".into(), json!(name));
        o.insert("via".into(), json!(via));
        o.insert("queued".into(), json!(true));
        o
    };
    if let Some(a) = &assignee {
        current = Some(make(a, "assignee"));
    } else if let Some(r) = &reviewer {
        current = Some(make(r, "reviewer"));
    } else if let Some(queue) = queue {
        let mut o = make("merge queue", "queue");
        if let Some(p) = queue
            .get("position")
            .filter(|p| p.as_f64().is_some_and(|n| n != 0.0))
        {
            o.insert("position".into(), p.clone());
        }
        current = Some(o);
    } else if let Some(auto) = auto_merge {
        let mut o = make("auto-merge", "auto_merge");
        if let Some(by) = auto
            .get("by")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            o.insert("by".into(), json!(by));
        }
        current = Some(o);
    } else if let Some(label) = &label {
        current = Some(make(label, "label"));
    }

    let kind = |e: &Value| js::sv(e.get("kind")).to_owned();
    let handed_at = |name: Option<&str>| -> Option<String> {
        let mut times: Vec<String> = events
            .iter()
            .filter(|e| {
                let k = kind(e);
                ((k == "assigned" || k == "review_requested")
                    && strs(e.get("who")).iter().any(|who| match name {
                        Some(name) => bot_name(who) == bot_name(name),
                        None => is_bot(Some(who)),
                    }))
                    || k == "queued"
                    || k == "auto_merge_on"
            })
            .map(|e| js::sv(e.get("at")).to_owned())
            .collect();
        times.sort();
        times.pop()
    };

    let mut failures: Vec<Failure> = Vec::new();
    for note in &input.notes {
        let author = js::sv(note.get("author"));
        if !is_bot(Some(author)) {
            continue;
        }
        if let Some(reason) =
            bot_failure_reason(js::sv(note.get("body")), &input.rules.bot_failures)
        {
            failures.push(Failure {
                reason,
                at: js::sv(note.get("at")).to_owned(),
                name: author.to_owned(),
                via: "assignee",
            });
        }
    }
    for event in &events {
        let k = kind(event);
        let actor = event.get("actor").and_then(Value::as_str);
        if (k == "unassigned" || k == "review_removed")
            && is_bot(actor)
            && strs(event.get("who"))
                .iter()
                .any(|who| bot_name(who) == bot_name(actor.unwrap_or("")))
        {
            let actor = actor.unwrap_or("");
            let event_at = js::date_parse(js::sv(event.get("at")));
            let said = input.notes.iter().rfind(|note| {
                bot_name(js::sv(note.get("author"))) == bot_name(actor)
                    && (js::date_parse(js::sv(note.get("at"))) - event_at).abs() < 60.0 * MINUTE
            });
            let reason = match said {
                Some(note) => {
                    let body = js::sv(note.get("body"));
                    bot_failure_reason(body, &input.rules.bot_failures)
                        .unwrap_or_else(|| js::head16(&squash(body), 200))
                }
                None => format!("{actor} unassigned itself"),
            };
            failures.push(Failure {
                reason,
                at: js::sv(event.get("at")).to_owned(),
                name: actor.to_owned(),
                via: if k == "review_removed" {
                    "reviewer"
                } else {
                    "assignee"
                },
            });
        }
        let reason = js::sv(event.get("reason"));
        if (k == "dequeued" || k == "auto_merge_off")
            && !(actor.is_some_and(|a| !a.is_empty())
                && !me.is_empty()
                && bot_name(actor.unwrap_or("")) == me)
            && (!reason.is_empty() || k == "dequeued")
        {
            failures.push(Failure {
                reason: if k == "dequeued" {
                    format!(
                        "removed from the merge queue{}",
                        if reason.is_empty() {
                            String::new()
                        } else {
                            format!(": {reason}")
                        }
                    )
                } else {
                    format!("auto-merge turned off: {reason}")
                },
                at: js::sv(event.get("at")).to_owned(),
                name: if k == "dequeued" {
                    "merge queue"
                } else {
                    "auto-merge"
                }
                .into(),
                via: if k == "dequeued" {
                    "queue"
                } else {
                    "auto_merge"
                },
            });
        }
    }
    failures.sort_by(|a, b| {
        js::date_parse(&a.at)
            .partial_cmp(&js::date_parse(&b.at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let failure = failures.last();
    let failed = |f: &Failure| json!({"reason": f.reason, "at": f.at});
    if let Some(mut current) = current {
        let via = js::sv(current.get("via")).to_owned();
        let name = js::sv(current.get("name")).to_owned();
        let handed = handed_at(if via == "label" { None } else { Some(&name) });
        if let Some(f) = failure
            && (handed.is_some() || via == "label")
            && later_than(Some(&f.at), handed.as_deref())
        {
            current.insert("queued".into(), json!(false));
            current.insert("failed".into(), failed(f));
        }
        return Some(current);
    }
    if let Some(f) = failure
        && later_than(Some(&f.at), handed_at(None).as_deref())
    {
        let mut o = Obj::new();
        o.insert("name".into(), json!(f.name));
        o.insert("via".into(), json!(f.via));
        o.insert("queued".into(), json!(false));
        o.insert("failed".into(), failed(f));
        return Some(o);
    }
    None
}

/// "queued to merge by marge-bot", "#2 in the merge queue", "auto-merge set by alice".
pub fn bot_label(bot: &Obj) -> String {
    let name = js::sv(bot.get("name"));
    let position = bot
        .get("position")
        .and_then(Value::as_f64)
        .filter(|p| *p != 0.0);
    match js::sv(bot.get("via")) {
        "queue" => match position {
            Some(p) => format!("#{} in the merge queue", js::number_text(p)),
            None => "in the merge queue".into(),
        },
        "auto_merge" => match bot
            .get("by")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            Some(by) => format!("auto-merge set by {by}"),
            None => "auto-merge set".into(),
        },
        "label" => format!("queued to merge ({name})"),
        _ => format!("queued to merge by {name}"),
    }
}

/// A failed attempt in a few words.
pub fn bot_failed_label(bot: &Obj) -> String {
    match js::sv(bot.get("via")) {
        "queue" => "left the merge queue".into(),
        "auto_merge" => "auto-merge turned off".into(),
        _ => format!("{} could not merge", js::sv(bot.get("name"))),
    }
}

/// What a failed attempt asks of the user: the bot's reason.
pub fn bot_failed_next(bot: &Obj) -> String {
    let reason = js::sv(bot.get("failed").and_then(|f| f.get("reason")));
    match js::sv(bot.get("via")) {
        "queue" | "auto_merge" => {
            let mut chars = reason.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        }
        _ => format!("{} could not merge: {reason}", js::sv(bot.get("name"))),
    }
}

/// What a queued request's next step says.
pub fn bot_queued_next(bot: &Obj) -> String {
    let name = js::sv(bot.get("name"));
    let position = bot
        .get("position")
        .and_then(Value::as_f64)
        .filter(|p| *p != 0.0);
    match js::sv(bot.get("via")) {
        "queue" => match position {
            Some(p) => format!(
                "Merging from the merge queue (#{}): nothing to do",
                js::number_text(p)
            ),
            None => "Merging from the merge queue: nothing to do".into(),
        },
        "auto_merge" => "Merges itself once the pipeline succeeds".into(),
        "label" => format!("Waits for the merge bot ({name})"),
        _ => format!("{name} merges it: nothing to do unless it fails"),
    }
}

/// What the merge state says to the inference's facts.
pub fn merge_fact(info: Option<&Obj>) -> String {
    let Some(info) = info else {
        return String::new();
    };
    let bot = info.get("bot");
    if let Some(at) = bot.and_then(|b| b.get("failed")).and_then(|f| f.get("at")) {
        return format!("failed:{}", js::to_text(at));
    }
    if bot.is_some_and(|b| js::is_true(b.get("queued"))) {
        return "queued".into();
    }
    match info.get("after") {
        Some(after) if js::is_true(after.get("ready")) => "ready".into(),
        Some(_) => "scheduled".into(),
        None => String::new(),
    }
}
