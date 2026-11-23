//! The voices known across calls (server/src/voice/voice-profiles.ts): one
//! file per person in `voice-profiles/` under Roamgate's data directory,
//! with a name, a role, a few voice prints (WeSpeaker embeddings, never
//! audio) and how much was heard. A file deleted while the server runs
//! stays deleted: what was loaded of it is dropped, not written back.

use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use roamgate_base::log::Logger;
use serde_json::{Map, Value, json};

use crate::js;

pub const VOICE_PROFILES_DIR: &str = "voice-profiles";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceRole {
    User,
    Family,
    Other,
    Unknown,
}

impl VoiceRole {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "user" => Self::User,
            "family" => Self::Family,
            "other" => Self::Other,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Family => "family",
            Self::Other => "other",
            Self::Unknown => "unknown",
        }
    }
}

/// The print one call left of a person.
#[derive(Debug, Clone, PartialEq)]
pub struct KeptPrint {
    pub print: Vec<f64>,
    /// Seconds of confident utterances it is the mean of.
    pub seconds: f64,
    /// The call (the helper's set of voices) it came from.
    pub call: f64,
    /// When it was last updated (ms since the epoch).
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VoiceProfile {
    pub id: String,
    pub name: Option<String>,
    pub role: VoiceRole,
    pub prints: Vec<KeptPrint>,
    pub seconds: f64,
    pub calls: f64,
    pub first: f64,
    pub last: f64,
    pub offered: bool,
}

/// A cluster of a call matched against the library.
#[derive(Debug, Clone, PartialEq)]
pub struct VoiceMatch {
    /// The best profile's id and its score.
    pub best: Option<(String, f64)>,
    /// The next best score, -1 without one.
    pub second: f64,
    pub sure: bool,
    pub maybe: bool,
}

pub const MATCH: f64 = 0.6;
pub const MAYBE: f64 = 0.45;
pub const MARGIN: f64 = 0.15;
/// Prints kept per person at most.
pub const MAX_PRINTS: usize = 6;
/// A merged print counts at most this many seconds.
const MAX_PRINT_SECONDS: f64 = 600.0;
/// Unnamed voices kept at most: past it, the least heard goes.
pub const MAX_UNNAMED: usize = 12;

pub fn voice_profiles_dir(root: &Path) -> PathBuf {
    root.join(VOICE_PROFILES_DIR)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

/// A unit vector, or None for nothing to scale.
pub fn unit(vector: &[f64]) -> Option<Vec<f64>> {
    let mut norm = 0.0;
    for value in vector {
        norm += value * value;
    }
    let norm = norm.sqrt();
    if vector.is_empty() || norm.is_nan() || norm <= 1e-9 {
        return None;
    }
    Some(vector.iter().map(|value| value / norm).collect())
}

/// Cosine of two unit prints; -1 when they cannot be compared.
pub fn cosine(a: &[f64], b: &[f64]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return -1.0;
    }
    let mut sum = 0.0;
    for (x, y) in a.iter().zip(b) {
        sum += x * y;
    }
    sum
}

/// A print as sent: rounded to four decimals.
pub fn round_print(print: &[f64]) -> Vec<f64> {
    print
        .iter()
        .map(|value| js::round(value * 10_000.0) / 10_000.0)
        .collect()
}

/// A print from JSON, checked: numbers only, 16 to 4096 of them.
pub fn parse_print(value: Option<&Value>) -> Option<Vec<f64>> {
    let items = value?.as_array()?;
    if items.len() < 16 || items.len() > 4096 {
        return None;
    }
    let numbers: Option<Vec<f64>> = items
        .iter()
        .map(|item| item.as_f64().filter(|value| value.is_finite()))
        .collect();
    unit(&numbers?)
}

/// A person's closeness to `print`: their closest kept print's.
pub fn profile_score(
    profile: &VoiceProfile,
    print: &[f64],
    except_call: Option<f64>,
) -> Option<f64> {
    let mut best: Option<f64> = None;
    for kept in &profile.prints {
        if Some(kept.call) == except_call {
            continue;
        }
        let score = cosine(&kept.print, print);
        if best.is_none_or(|best| score > best) {
            best = Some(score);
        }
    }
    best
}

/// The person `print` is, among `profiles`.
pub fn match_print(
    print: &[f64],
    profiles: &[&VoiceProfile],
    call: Option<f64>,
    rejected: &HashSet<String>,
) -> VoiceMatch {
    let mut scored: Vec<(String, f64)> = profiles
        .iter()
        .filter(|profile| !rejected.contains(&profile.id))
        .filter_map(|profile| {
            profile_score(profile, print, call).map(|score| (profile.id.clone(), score))
        })
        .collect();
    // Array.prototype.sort is stable.
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored.first().cloned();
    let second = scored.get(1).map_or(-1.0, |(_, score)| *score);
    let sure = best
        .as_ref()
        .is_some_and(|(_, score)| *score >= MATCH && score - second >= MARGIN);
    let maybe = !sure && best.as_ref().is_some_and(|(_, score)| *score >= MAYBE);
    VoiceMatch {
        best,
        second,
        sure,
        maybe,
    }
}

static NOT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[^\p{L}\p{N} '.\-]").expect("regex"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("regex"));

/// A name as said, kept short and printable.
pub fn clean_name(name: &str) -> Option<String> {
    let clean = NOT_NAME.replace_all(name, " ");
    let clean = SPACES.replace_all(&clean, " ");
    let clean = js::slice16(js::trim(&clean), 0, Some(40));
    (!clean.is_empty()).then_some(clean)
}

fn parse_profile(id: &str, value: &Value) -> Option<VoiceProfile> {
    let raw = value.as_object()?;
    let role = raw
        .get("role")
        .and_then(Value::as_str)
        .and_then(VoiceRole::parse)
        .unwrap_or(VoiceRole::Other);
    let prints = raw
        .get("prints")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|each| {
                    let kept = each.as_object();
                    let get = |key: &str| kept.and_then(|kept| kept.get(key));
                    let print = parse_print(get("print"))?;
                    Some(KeptPrint {
                        print,
                        seconds: finite(get("seconds"))?,
                        call: finite(get("call"))?,
                        at: finite(get("at")).unwrap_or(0.0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let name = raw
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !js::trim(name).is_empty())
        .and_then(clean_name);
    Some(VoiceProfile {
        id: id.to_owned(),
        name,
        role,
        prints,
        seconds: finite(raw.get("seconds")).unwrap_or(0.0),
        calls: finite(raw.get("calls")).unwrap_or(0.0),
        first: finite(raw.get("first")).unwrap_or(0.0),
        last: finite(raw.get("last")).unwrap_or(0.0),
        offered: raw.get("offered") == Some(&Value::Bool(true)),
    })
}

static FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z0-9]{6,32})\.json$").expect("regex"));

/// Two prints as one, by their seconds.
fn merge_prints(a: &KeptPrint, b: &KeptPrint) -> KeptPrint {
    let total = (a.seconds + b.seconds).max(1e-6);
    let mixed: Vec<f64> = a
        .print
        .iter()
        .enumerate()
        .map(|(i, value)| {
            (value * a.seconds + b.print.get(i).copied().unwrap_or(f64::NAN) * b.seconds) / total
        })
        .collect();
    KeptPrint {
        print: unit(&mixed).unwrap_or_else(|| a.print.clone()),
        seconds: total.min(MAX_PRINT_SECONDS),
        call: if a.at >= b.at { a.call } else { b.call },
        at: a.at.max(b.at),
    }
}

/// A change of name or role (`update`).
#[derive(Debug, Clone, Default)]
pub struct ProfileChange {
    pub name: Option<String>,
    pub role: Option<VoiceRole>,
}

pub type Now = Arc<dyn Fn() -> f64 + Send + Sync>;

/// The library of voices, one file each.
pub struct VoiceProfiles {
    pub dir: PathBuf,
    now: Now,
    loaded: bool,
    known: IndexMap<String, VoiceProfile>,
    /// Profiles read from or written to a file: gone from disk means deleted.
    stored: HashSet<String>,
    log: Logger,
}

impl VoiceProfiles {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self::with_clock(
            dir,
            Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
            }),
        )
    }

    pub fn with_clock(dir: impl Into<PathBuf>, now: Now) -> Self {
        Self {
            dir: dir.into(),
            now,
            loaded: false,
            known: IndexMap::new(),
            stored: HashSet::new(),
            log: Logger::silent(),
        }
    }

    pub fn set_logger(&mut self, log: Logger) {
        self.log = log;
    }

    /// Reads the files again: deleted ones are forgotten (each new call).
    pub fn reload(&mut self) {
        self.loaded = true;
        self.known.clear();
        self.stored.clear();
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            let Some(id) = FILE.captures(&file).map(|found| found[1].to_owned()) else {
                continue;
            };
            let parsed = fs::read_to_string(self.dir.join(&file))
                .map_err(|error| error.to_string())
                .and_then(|text| {
                    serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
                });
            match parsed {
                Ok(value) => {
                    if let Some(profile) = parse_profile(&id, &value) {
                        self.known.insert(id.clone(), profile);
                        self.stored.insert(id);
                    }
                }
                Err(error) => {
                    let mut fields = roamgate_base::log::LogFields::new();
                    fields.insert("file".into(), json!(file));
                    fields.insert("error".into(), json!(error));
                    self.log
                        .warn("voice profiles: unreadable file skipped", Some(&fields));
                }
            }
        }
    }

    fn ensure(&mut self) {
        if !self.loaded {
            self.reload();
        }
    }

    pub fn profiles(&mut self) -> Vec<VoiceProfile> {
        self.ensure();
        self.known.values().cloned().collect()
    }

    pub fn ids(&mut self) -> Vec<String> {
        self.ensure();
        self.known.keys().cloned().collect()
    }

    pub fn get(&mut self, id: &str) -> Option<&VoiceProfile> {
        self.ensure();
        self.known.get(id)
    }

    /// The user's own profile, if one is kept.
    pub fn user(&mut self) -> Option<&VoiceProfile> {
        self.ensure();
        self.known
            .values()
            .find(|profile| profile.role == VoiceRole::User)
    }

    pub fn by_name(&mut self, name: &str) -> Option<&VoiceProfile> {
        self.ensure();
        let wanted = js::trim(name).to_lowercase();
        self.known.values().find(|profile| {
            profile
                .name
                .as_ref()
                .is_some_and(|name| name.to_lowercase() == wanted)
        })
    }

    /// A new person, kept from now on (their file is written once learnt).
    pub fn create(&mut self, name: Option<&str>, role: VoiceRole) -> String {
        self.ensure();
        let now = (self.now)();
        let mut bytes = [0u8; 8];
        rand::fill(&mut bytes);
        let profile = VoiceProfile {
            id: hex::encode(bytes),
            name: name.and_then(clean_name),
            role,
            prints: Vec::new(),
            seconds: 0.0,
            calls: 0.0,
            first: now,
            last: now,
            offered: false,
        };
        let id = profile.id.clone();
        self.known.insert(id.clone(), profile);
        if role == VoiceRole::Unknown {
            self.bound_unnamed(&id);
        }
        id
    }

    /// `id`'s print from call `call`, replacing what the call gave before.
    pub fn learn(&mut self, id: &str, call: f64, print: Vec<f64>, seconds: f64) {
        let now = (self.now)();
        let Some(profile) = self.known.get_mut(id) else {
            return;
        };
        let index = profile.prints.iter().position(|kept| kept.call == call);
        let before = index.map_or(0.0, |index| profile.prints[index].seconds);
        let kept = KeptPrint {
            print,
            seconds,
            call,
            at: now,
        };
        match index {
            Some(index) => profile.prints[index] = kept,
            None => {
                profile.prints.push(kept);
                profile.calls += 1.0;
            }
        }
        profile.seconds += (seconds - before).max(0.0);
        profile.last = now;
        bound(profile, Some(call));
        self.save(id);
    }

    /// What call `call` taught of `id` is undone (a wrong name).
    pub fn forget_call(&mut self, id: &str, call: f64) {
        let Some(profile) = self.known.get_mut(id) else {
            return;
        };
        let Some(index) = profile.prints.iter().position(|kept| kept.call == call) else {
            return;
        };
        let gone = profile.prints.remove(index);
        profile.seconds = (profile.seconds - gone.seconds).max(0.0);
        profile.calls = (profile.calls - 1.0).max(0.0);
        // An unnamed voice made from a voice that was not one is dropped.
        if profile.prints.is_empty() && profile.role == VoiceRole::Unknown {
            self.remove(id);
            return;
        }
        self.save(id);
    }

    /// `from`'s prints move to `into` (an unnamed voice given a name).
    pub fn absorb(&mut self, into: &str, from: &str) {
        if into == from {
            return;
        }
        let Some(source) = self.known.get(from).cloned() else {
            return;
        };
        let Some(target) = self.known.get_mut(into) else {
            return;
        };
        for kept in &source.prints {
            match target.prints.iter().position(|each| each.call == kept.call) {
                Some(index) => target.prints[index] = merge_prints(&target.prints[index], kept),
                None => target.prints.push(kept.clone()),
            }
        }
        target.seconds += source.seconds;
        target.calls += source.calls;
        target.first = target.first.min(source.first);
        target.last = target.last.max(source.last);
        bound(target, None);
        self.save(into);
        self.remove(from);
    }

    /// A name or role given.
    pub fn update(&mut self, id: &str, change: ProfileChange) {
        if !self.known.contains_key(id) {
            return;
        }
        if let Some(name) = &change.name {
            let name = clean_name(name);
            if let Some(profile) = self.known.get_mut(id) {
                profile.name = name;
            }
        }
        if let Some(role) = change.role {
            // One user: another taken for them before is not any more.
            if role == VoiceRole::User {
                let others: Vec<String> = self
                    .profiles()
                    .into_iter()
                    .filter(|other| other.id != id && other.role == VoiceRole::User)
                    .map(|other| other.id)
                    .collect();
                for other in others {
                    if let Some(profile) = self.known.get_mut(&other) {
                        profile.role = VoiceRole::Other;
                    }
                    self.save(&other);
                }
            }
            if let Some(profile) = self.known.get_mut(id) {
                profile.role = role;
            }
        }
        self.save(id);
    }

    pub fn mark_offered(&mut self, id: &str) {
        if let Some(profile) = self.known.get_mut(id) {
            profile.offered = true;
        }
        self.save(id);
    }

    pub fn remove(&mut self, id: &str) {
        self.known.shift_remove(id);
        if self.stored.remove(id) {
            let _ = fs::remove_file(self.dir.join(format!("{id}.json")));
        }
    }

    fn bound_unnamed(&mut self, keep: &str) {
        let mut unnamed: Vec<VoiceProfile> = self
            .profiles()
            .into_iter()
            .filter(|profile| profile.role == VoiceRole::Unknown && profile.id != keep)
            .collect();
        unnamed.sort_by(|a, b| {
            let by = a.seconds - b.seconds;
            let by = if by != 0.0 { by } else { a.last - b.last };
            by.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut unnamed = std::collections::VecDeque::from(unnamed);
        while unnamed.len() >= MAX_UNNAMED {
            if let Some(gone) = unnamed.pop_front() {
                self.remove(&gone.id);
            }
        }
    }

    /// The JSON text of a profile's file.
    pub fn file_text(profile: &VoiceProfile) -> String {
        let mut kept = Map::new();
        kept.insert(
            "name".into(),
            profile.name.clone().map_or(Value::Null, Value::String),
        );
        kept.insert("role".into(), json!(profile.role.as_str()));
        kept.insert(
            "prints".into(),
            Value::Array(
                profile
                    .prints
                    .iter()
                    .map(|each| {
                        json!({
                            "print": round_print(&each.print).into_iter().map(js::number).collect::<Vec<_>>(),
                            "seconds": js::number(each.seconds),
                            "call": js::number(each.call),
                            "at": js::number(each.at),
                        })
                    })
                    .collect(),
            ),
        );
        kept.insert("seconds".into(), js::number(profile.seconds));
        kept.insert("calls".into(), js::number(profile.calls));
        kept.insert("first".into(), js::number(profile.first));
        kept.insert("last".into(), js::number(profile.last));
        if profile.offered {
            kept.insert("offered".into(), Value::Bool(true));
        }
        format!("{}\n", js::stringify(&Value::Object(kept)))
    }

    /// Written whole, private to the user; a file deleted meanwhile stays so.
    fn save(&mut self, id: &str) {
        let Some(profile) = self.known.get(id) else {
            return;
        };
        let file = self.dir.join(format!("{id}.json"));
        if self.stored.contains(id) && !file.exists() {
            self.known.shift_remove(id);
            self.stored.remove(id);
            let mut fields = roamgate_base::log::LogFields::new();
            fields.insert("id".into(), json!(id));
            self.log.info(
                "voice profiles: a deleted voice stays forgotten",
                Some(&fields),
            );
            return;
        }
        let text = Self::file_text(profile);
        let written = (|| -> std::io::Result<()> {
            create_private_dirs(&self.dir)?;
            let temp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
            write_private(&temp, text.as_bytes())?;
            fs::rename(&temp, &file)
        })();
        match written {
            Ok(()) => {
                self.stored.insert(id.to_owned());
            }
            Err(error) => {
                let mut fields = roamgate_base::log::LogFields::new();
                fields.insert("id".into(), json!(id));
                fields.insert("error".into(), json!(error.to_string()));
                self.log.warn("voice profiles: not written", Some(&fields));
            }
        }
    }
}

/// Past MAX_PRINTS, the two closest prints are one (this call's kept).
fn bound(profile: &mut VoiceProfile, call: Option<f64>) {
    while profile.prints.len() > MAX_PRINTS {
        let mut pair: Option<(usize, usize)> = None;
        let mut closest = -2.0;
        for i in 0..profile.prints.len() {
            for j in i + 1..profile.prints.len() {
                // The call going on keeps its own print, to replace as it goes.
                if Some(profile.prints[i].call) == call || Some(profile.prints[j].call) == call {
                    continue;
                }
                let score = cosine(&profile.prints[i].print, &profile.prints[j].print);
                if score > closest {
                    closest = score;
                    pair = Some((i, j));
                }
            }
        }
        let Some((i, j)) = pair else {
            return;
        };
        let merged = merge_prints(&profile.prints[i], &profile.prints[j]);
        profile.prints.remove(j);
        profile.prints[i] = merged;
    }
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
pub(crate) fn create_private_dirs(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// `writeFileSync(path, bytes, { mode: 0o600 })`.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)
}

#[cfg(test)]
mod tests;
