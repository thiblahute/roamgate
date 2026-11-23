//! Who speaks on a call (server/src/voice/voice-speakers.ts): the helper
//! tells the voices it hears apart (A, B, C...), the people known from
//! earlier calls ([`crate::profiles`]) name them, the conversation teaches
//! which voice is the user's, and each utterance gets a label for the
//! companion, the cleaner and the router.

use std::collections::HashSet;
use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value, json};

use crate::js;
use crate::profiles::{
    MAYBE, ProfileChange, VoiceProfile, VoiceProfiles, VoiceRole, match_print, parse_print,
    profile_score, round_print, unit,
};

/// What the helper says of an utterance's voices (a final's `voice`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VoiceTag {
    /// The set of voices its names belong to: a new one each call.
    pub voices: f64,
    /// The voice most heard, None when too little was heard to tell.
    pub id: Option<String>,
    pub share: f64,
    pub mixed: bool,
    /// Each voice heard and its share, the most heard first.
    pub mix: Vec<(String, f64)>,
    /// How close the utterance is to each voice known, -1 to 1.
    pub similarity: IndexMap<String, f64>,
    /// Voices found to be one: gone name to kept name.
    pub merged: Option<IndexMap<String, String>>,
    pub print: Option<Vec<f64>>,
    pub prints: Option<IndexMap<String, Vec<f64>>>,
    pub utterance: Option<f64>,
    pub seconds: Option<f64>,
}

impl VoiceTag {
    /// As JSON, in the TS object's order.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("voices".into(), js::number(self.voices));
        out.insert(
            "id".into(),
            self.id.clone().map_or(Value::Null, Value::String),
        );
        out.insert("share".into(), js::number(self.share));
        out.insert("mixed".into(), Value::Bool(self.mixed));
        out.insert(
            "mix".into(),
            Value::Array(
                self.mix
                    .iter()
                    .map(|(id, share)| json!({"id": id, "share": js::number(*share)}))
                    .collect(),
            ),
        );
        out.insert(
            "similarity".into(),
            Value::Object(
                self.similarity
                    .iter()
                    .map(|(key, score)| (key.clone(), js::number(*score)))
                    .collect(),
            ),
        );
        if let Some(merged) = &self.merged {
            out.insert(
                "merged".into(),
                Value::Object(merged.iter().map(|(a, b)| (a.clone(), json!(b))).collect()),
            );
        }
        if let Some(print) = &self.print {
            out.insert("print".into(), numbers(print));
        }
        if let Some(prints) = &self.prints {
            out.insert(
                "prints".into(),
                Value::Object(
                    prints
                        .iter()
                        .map(|(id, print)| (id.clone(), numbers(print)))
                        .collect(),
                ),
            );
        }
        if let Some(utterance) = self.utterance {
            out.insert("utterance".into(), js::number(utterance));
        }
        if let Some(seconds) = self.seconds {
            out.insert("seconds".into(), js::number(seconds));
        }
        Value::Object(out)
    }
}

fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().copied().map(js::number).collect())
}

/// The user's voice, as told to the helper (listen_start's `user_voice`).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UserVoice {
    pub voices: Option<f64>,
    pub id: Option<String>,
    pub prints: Option<Vec<Vec<f64>>>,
}

impl UserVoice {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        if let Some(voices) = self.voices {
            out.insert("voices".into(), js::number(voices));
        }
        if let Some(id) = &self.id {
            out.insert("id".into(), json!(id));
        }
        if let Some(prints) = &self.prints {
            out.insert(
                "prints".into(),
                Value::Array(prints.iter().map(|print| numbers(print)).collect()),
            );
        }
        Value::Object(out)
    }
}

/// A name the companion gives a voice of the call.
#[derive(Debug, Clone, Default)]
pub struct VoiceNaming {
    pub voice: Option<String>,
    pub name: String,
    pub role: Option<VoiceRole>,
}

/// What the companion's route says of who spoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceVerdict {
    User,
    Other,
}

const TAKEN_UP: f64 = 1.0;
const LEFT: f64 = -1.0;
const SAID: f64 = 3.0;
const CLEAR_SHARE: f64 = 0.6;
const OTHER: f64 = 0.2;
const LEARN_SHARE: f64 = 0.8;
const LEARN_CLOSE: f64 = 0.45;
const LEARN_SECONDS: f64 = 1.0;
const KEEP_SECONDS: f64 = 3.0;
const UNNAMED_SECONDS: f64 = 20.0;
const OFFER_CALLS: f64 = 3.0;
const USER_SURE: f64 = 3.0;
const KEPT_UTTERANCES: usize = 64;

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Z]{1,2}$").expect("regex"));

/// A voice of the call's name, checked.
pub fn is_voice_name(value: &str) -> bool {
    NAME.is_match(value)
}

fn name_of(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| is_voice_name(value))
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

/// A final's `voice` (or a page's copy of it), checked.
pub fn parse_voice_tag(value: &Value) -> Option<VoiceTag> {
    let raw = value.as_object()?;
    let voices = finite(raw.get("voices"))?;
    let mut similarity = IndexMap::new();
    if let Some(object) = raw.get("similarity").and_then(Value::as_object) {
        for (key, score) in object {
            if let Some(score) = finite(Some(score))
                && is_voice_name(key)
            {
                similarity.insert(key.clone(), score);
            }
        }
    }
    let mix = raw
        .get("mix")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|each| {
                    let id = name_of(each.get("id"))?;
                    let share = finite(each.get("share"))?;
                    Some((id.to_owned(), share))
                })
                .collect()
        })
        .unwrap_or_default();
    let mut merged = IndexMap::new();
    if let Some(object) = raw.get("merged").and_then(Value::as_object) {
        for (gone, kept) in object {
            if let Some(kept) = name_of(Some(kept))
                && is_voice_name(gone)
            {
                merged.insert(gone.clone(), kept.to_owned());
            }
        }
    }
    let print = parse_print(raw.get("print"));
    let mut prints = IndexMap::new();
    if let Some(object) = raw.get("prints").and_then(Value::as_object) {
        for (id, each) in object {
            if is_voice_name(id)
                && let Some(parsed) = parse_print(Some(each))
            {
                prints.insert(id.clone(), parsed);
            }
        }
    }
    Some(VoiceTag {
        voices,
        id: name_of(raw.get("id")).map(str::to_owned),
        share: finite(raw.get("share")).unwrap_or(0.0),
        mixed: raw.get("mixed") == Some(&Value::Bool(true)),
        mix,
        similarity,
        merged: (!merged.is_empty()).then_some(merged),
        print,
        prints: (!prints.is_empty()).then_some(prints),
        utterance: finite(raw.get("utterance")),
        seconds: finite(raw.get("seconds")),
    })
}

/// A tag without its prints: what the page gets and sends back.
pub fn without_prints(tag: &VoiceTag) -> VoiceTag {
    VoiceTag {
        print: None,
        prints: None,
        ..tag.clone()
    }
}

fn score(value: Option<f64>) -> String {
    js::to_fixed(value.unwrap_or(0.0), 2)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkHow {
    Match,
    Named,
    User,
    Kept,
}

#[derive(Debug, Clone)]
struct Link {
    profile: String,
    how: LinkHow,
}

#[derive(Debug, Clone, Default)]
struct Cluster {
    print: Option<Vec<f64>>,
    sum: Option<Vec<f64>>,
    seconds: f64,
    link: Option<Link>,
    maybe: Option<(String, f64)>,
    closest: Vec<(String, f64)>,
    rejected: HashSet<String>,
}

/// Learns which voice is the user's on the call, names the voices with the
/// people known, and labels utterances.
#[derive(Default)]
pub struct SpeakerTracker {
    voices: Option<f64>,
    scores: IndexMap<String, f64>,
    user_id: Option<String>,
    clusters: IndexMap<String, Cluster>,
    utterances: IndexMap<u64, Vec<f64>>,
    next_utterance: u64,
    library: Option<VoiceProfiles>,
}

impl SpeakerTracker {
    pub fn new(library: Option<VoiceProfiles>) -> Self {
        Self {
            library,
            next_utterance: 1,
            ..Self::default()
        }
    }

    /// The people known across calls.
    pub fn use_library(&mut self, library: Option<VoiceProfiles>) {
        self.library = library;
    }

    pub fn library(&mut self) -> Option<&mut VoiceProfiles> {
        self.library.as_mut()
    }

    fn cluster(&mut self, id: &str) -> &mut Cluster {
        self.clusters.entry(id.to_owned()).or_default()
    }

    fn profile_of(&mut self, id: Option<&str>) -> Option<VoiceProfile> {
        let profile = self.clusters.get(id?)?.link.as_ref()?.profile.clone();
        self.library.as_mut()?.get(&profile).cloned()
    }

    /// A final's voices: a new set forgets the old; merged names carry.
    /// With its prints, the voices are matched with the people known, and
    /// those known learn from it. Gives the tag its `utterance`.
    pub fn observe(&mut self, tag: Option<&mut VoiceTag>) {
        let Some(tag) = tag else {
            return;
        };
        if Some(tag.voices) != self.voices {
            self.voices = Some(tag.voices);
            self.scores.clear();
            self.user_id = None;
            self.clusters.clear();
            if let Some(library) = self.library.as_mut() {
                library.reload();
            }
        }
        if let Some(merged) = tag.merged.clone() {
            for (gone, kept) in merged {
                if let Some(moved) = self.scores.shift_remove(&gone) {
                    *self.scores.entry(kept.clone()).or_insert(0.0) += moved;
                }
                if self.user_id.as_deref() == Some(gone.as_str()) {
                    self.user_id = Some(kept.clone());
                }
                self.merge_cluster(&gone, &kept);
            }
        }
        if let Some(print) = &tag.print
            && tag.utterance.is_none()
        {
            let utterance = self.next_utterance;
            self.next_utterance += 1;
            tag.utterance = Some(utterance as f64);
            self.utterances.insert(utterance, print.clone());
            if self.utterances.len() > KEPT_UTTERANCES {
                self.utterances.shift_remove_index(0);
            }
        }
        let Some(prints) = tag.prints.clone() else {
            return;
        };
        if self.library.is_none() {
            return;
        }
        for (id, print) in &prints {
            self.cluster(id).print = Some(print.clone());
        }
        if let (Some(id), Some(print)) = (tag.id.clone(), tag.print.clone())
            && !tag.mixed
            && tag.share >= LEARN_SHARE
            && tag.similarity.get(&id).copied().unwrap_or(0.0) >= LEARN_CLOSE
        {
            let seconds = tag.seconds.unwrap_or(0.0);
            if seconds >= LEARN_SECONDS {
                let weight = seconds * tag.share;
                let cluster = self.cluster(&id);
                let sum: Vec<f64> = print
                    .iter()
                    .enumerate()
                    .map(|(i, value)| {
                        cluster
                            .sum
                            .as_ref()
                            .and_then(|sum| sum.get(i).copied())
                            .unwrap_or(0.0)
                            + value * weight
                    })
                    .collect();
                cluster.sum = Some(sum);
                cluster.seconds += weight;
            }
        }
        for id in prints.keys() {
            self.match_cluster(id);
        }
        self.seed_user();
        for id in prints.keys() {
            self.keep_unnamed(id);
            self.teach(id);
        }
    }

    fn merge_cluster(&mut self, gone: &str, kept: &str) {
        let Some(from) = self.clusters.shift_remove(gone) else {
            return;
        };
        let into = self.cluster(kept);
        if let Some(sum) = &from.sum {
            into.sum = Some(
                sum.iter()
                    .enumerate()
                    .map(|(i, value)| {
                        value
                            + into
                                .sum
                                .as_ref()
                                .and_then(|s| s.get(i).copied())
                                .unwrap_or(0.0)
                    })
                    .collect(),
            );
        }
        into.seconds += from.seconds;
        into.rejected.extend(from.rejected.iter().cloned());
        let strong = |how: Option<LinkHow>| matches!(how, Some(LinkHow::Named | LinkHow::User));
        if let Some(link) = from.link
            && (into.link.is_none()
                || (strong(Some(link.how)) && !strong(into.link.as_ref().map(|link| link.how))))
        {
            into.link = Some(link);
        }
    }

    /// A voice of the call against the people known.
    fn match_cluster(&mut self, id: &str) {
        let Some(call) = self.voices else {
            return;
        };
        let Some(print) = self
            .clusters
            .get(id)
            .and_then(|cluster| cluster.print.clone())
        else {
            return;
        };
        let Some(library) = self.library.as_mut() else {
            return;
        };
        let profiles = library.profiles();
        let mut closest: Vec<(String, f64)> = profiles
            .iter()
            .filter_map(|profile| {
                profile_score(profile, &print, Some(call)).map(|score| (profile.id.clone(), score))
            })
            .collect();
        closest.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        closest.truncate(3);
        let cluster = self.clusters.get_mut(id).expect("cluster");
        cluster.closest = closest;
        // A name given or learnt on the call stays.
        if cluster
            .link
            .as_ref()
            .is_some_and(|link| link.how != LinkHow::Match)
        {
            return;
        }
        let refs: Vec<&VoiceProfile> = profiles.iter().collect();
        let found = match_print(&print, &refs, Some(call), &cluster.rejected);
        cluster.maybe = if found.maybe {
            found.best.clone()
        } else {
            None
        };
        let was = cluster.link.as_ref().map(|link| link.profile.clone());
        if found.sure
            && let Some((best, _)) = &found.best
        {
            if was.as_deref() == Some(best.as_str()) {
                return;
            }
            self.unlink(id, false);
            let cluster = self.clusters.get_mut(id).expect("cluster");
            cluster.link = Some(Link {
                profile: best.clone(),
                how: LinkHow::Match,
            });
            cluster.maybe = None;
        } else if let Some(was) = was
            && !found
                .best
                .as_ref()
                .is_some_and(|(best, score)| *best == was && *score >= MAYBE)
        {
            // No longer close enough: what it taught is undone.
            self.unlink(id, false);
        }
    }

    /// A voice of the call is no one known any more (on this call).
    fn unlink(&mut self, id: &str, reject: bool) {
        let Some(cluster) = self.clusters.get_mut(id) else {
            return;
        };
        let linked = cluster.link.take();
        if let (Some(link), Some(call), Some(library)) =
            (linked, self.voices, self.library.as_mut())
            && library.get(&link.profile).is_some()
        {
            library.forget_call(&link.profile, call);
            if reject {
                cluster.rejected.insert(link.profile);
            }
        }
    }

    /// A voice of the call matched to the user's profile is theirs.
    fn seed_user(&mut self) {
        let ids: Vec<String> = self.clusters.keys().cloned().collect();
        for id in ids {
            let matched = self.clusters[&id]
                .link
                .as_ref()
                .is_some_and(|link| link.how == LinkHow::Match);
            if self.profile_of(Some(&id)).map(|profile| profile.role) != Some(VoiceRole::User)
                || !matched
            {
                continue;
            }
            if self.scores.get(&id).copied().unwrap_or(0.0) < USER_SURE {
                self.scores.insert(id.clone(), USER_SURE);
                self.choose();
            }
        }
    }

    /// A voice heard long that is no one known is kept, unnamed.
    fn keep_unnamed(&mut self, id: &str) {
        if self.library.is_none() || self.voices.is_none() {
            return;
        }
        let cluster = self.cluster(id);
        if cluster.link.is_some()
            || cluster.maybe.is_some()
            || cluster.seconds < UNNAMED_SECONDS
            || self.user_id.as_deref() == Some(id)
            || self.scores.get(id).copied().unwrap_or(0.0) > 0.0
        {
            return;
        }
        let profile = self
            .library
            .as_mut()
            .expect("library")
            .create(None, VoiceRole::Unknown);
        self.cluster(id).link = Some(Link {
            profile,
            how: LinkHow::Kept,
        });
    }

    /// A known voice's confident utterances so far, kept as this call's print.
    fn teach(&mut self, id: &str) {
        let Some(call) = self.voices else {
            return;
        };
        let Some(profile) = self.profile_of(Some(id)) else {
            return;
        };
        let Some(cluster) = self.clusters.get(id) else {
            return;
        };
        let Some(sum) = &cluster.sum else {
            return;
        };
        if cluster.seconds < KEEP_SECONDS {
            return;
        }
        let seconds = cluster.seconds;
        if let Some(print) = unit(sum)
            && let Some(library) = self.library.as_mut()
        {
            library.learn(&profile.id, call, print, seconds);
        }
    }

    /// What the companion (or the router) did with an utterance.
    pub fn learn(&mut self, tag: Option<&mut VoiceTag>, to: &str, verdict: Option<VoiceVerdict>) {
        let Some(tag) = tag else {
            return;
        };
        let Some(id) = tag.id.clone() else {
            return;
        };
        self.observe(Some(tag));
        // A voice known as someone else is not the user's by its route.
        if let Some(known) = self.profile_of(Some(&id))
            && known.role != VoiceRole::User
            && known.role != VoiceRole::Unknown
        {
            return;
        }
        let change = match verdict {
            Some(VoiceVerdict::User) => SAID,
            Some(VoiceVerdict::Other) => -SAID,
            None if !tag.mixed && tag.share >= CLEAR_SHARE => {
                if to == "nobody" {
                    LEFT
                } else {
                    TAKEN_UP
                }
            }
            None => 0.0,
        };
        if change == 0.0 {
            return;
        }
        *self.scores.entry(id.clone()).or_insert(0.0) += change;
        self.choose();
        self.keep_user(&id);
    }

    fn keep_user(&mut self, id: &str) {
        if self.library.is_none() {
            return;
        }
        let profile = self.profile_of(Some(id));
        let score = self.scores.get(id).copied().unwrap_or(0.0);
        if profile
            .as_ref()
            .is_some_and(|profile| profile.role == VoiceRole::User)
            && score <= 0.0
        {
            self.cluster(id);
            self.unlink(id, true);
            return;
        }
        if self.user_id.as_deref() != Some(id) || score < USER_SURE {
            return;
        }
        if profile
            .as_ref()
            .is_some_and(|profile| profile.role != VoiceRole::Unknown)
        {
            return;
        }
        let library = self.library.as_mut().expect("library");
        let user = library.user().cloned();
        if let Some(user) = &user
            && self
                .clusters
                .get(id)
                .is_some_and(|cluster| cluster.rejected.contains(&user.id))
        {
            return;
        }
        let kept = match (&profile, &user) {
            (Some(profile), Some(user)) => {
                // Kept unnamed before the call knew it was theirs.
                library.absorb(&user.id, &profile.id);
                user.id.clone()
            }
            (Some(profile), None) => {
                library.update(
                    &profile.id,
                    ProfileChange {
                        role: Some(VoiceRole::User),
                        ..Default::default()
                    },
                );
                profile.id.clone()
            }
            (None, Some(user)) => user.id.clone(),
            (None, None) => library.create(None, VoiceRole::User),
        };
        let cluster = self.cluster(id);
        cluster.link = Some(Link {
            profile: kept,
            how: LinkHow::User,
        });
        cluster.maybe = None;
        self.teach(id);
    }

    /// The companion names a voice of the call; what was done, for the log.
    pub fn name(&mut self, tag: Option<&mut VoiceTag>, naming: &VoiceNaming) -> Option<String> {
        self.library.as_ref()?;
        let tag = tag?;
        self.observe(Some(tag));
        let id = naming
            .voice
            .as_deref()
            .filter(|voice| is_voice_name(voice))
            .map(str::to_owned)
            .or_else(|| tag.id.clone())?;
        if Some(tag.voices) != self.voices {
            return None;
        }
        // Merged since: under its kept name.
        let id = tag
            .merged
            .as_ref()
            .and_then(|merged| merged.get(&id).cloned())
            .unwrap_or(id);
        let given = js::trim(&naming.name).to_owned();
        if given.is_empty() {
            return None;
        }
        self.cluster(&id);
        let before = self.profile_of(Some(&id));
        let library = self.library.as_mut().expect("library");
        let target = if naming.role == Some(VoiceRole::User) {
            let target = match library.user().map(|user| user.id.clone()) {
                Some(user) => user,
                None => match library.by_name(&given).map(|found| found.id.clone()) {
                    Some(found) => found,
                    None => library.create(Some(&given), VoiceRole::User),
                },
            };
            library.update(
                &target,
                ProfileChange {
                    name: Some(given.clone()),
                    role: Some(VoiceRole::User),
                },
            );
            target
        } else {
            let target = match library.by_name(&given).map(|found| found.id.clone()) {
                Some(found) => found,
                None => library.create(Some(&given), naming.role.unwrap_or(VoiceRole::Other)),
            };
            let role = library.get(&target).map(|profile| profile.role);
            match naming.role {
                Some(wanted) if Some(wanted) != role => library.update(
                    &target,
                    ProfileChange {
                        role: Some(wanted),
                        ..Default::default()
                    },
                ),
                _ => library.update(&target, ProfileChange::default()),
            }
            target
        };
        if let Some(before) = &before
            && before.id != target
        {
            if before.role == VoiceRole::Unknown {
                self.library
                    .as_mut()
                    .expect("library")
                    .absorb(&target, &before.id);
            } else {
                self.unlink(&id, true);
            }
        }
        let cluster = self.cluster(&id);
        cluster.link = Some(Link {
            profile: target.clone(),
            how: LinkHow::Named,
        });
        cluster.maybe = None;
        cluster.rejected.remove(&target);
        let named = self
            .library
            .as_mut()
            .expect("library")
            .get(&target)
            .cloned()?;
        if named.role == VoiceRole::User {
            let current = self.scores.get(&id).copied().unwrap_or(0.0);
            self.scores.insert(id.clone(), current.max(SAID * 2.0));
            self.user_id = Some(id.clone());
        } else if self.user_id.as_deref() == Some(id.as_str())
            || self.scores.get(&id).copied().unwrap_or(0.0) > 0.0
        {
            self.scores.insert(id.clone(), -SAID);
            self.choose();
        }
        self.teach(&id);
        let was = match &before {
            Some(before) if before.id != named.id => {
                format!(", was {}", before.name.as_deref().unwrap_or("unnamed"))
            }
            _ => String::new(),
        };
        Some(format!(
            "voice {id} is {} ({}){was}",
            named.name.as_deref().unwrap_or("unnamed"),
            named.role.as_str()
        ))
    }

    fn choose(&mut self) {
        let mut best: Option<String> = None;
        for (id, value) in &self.scores {
            if *value >= 1.0 && best.as_ref().is_none_or(|best| *value > self.scores[best]) {
                best = Some(id.clone());
            }
        }
        let current = self
            .user_id
            .as_ref()
            .map_or(0.0, |user| self.scores.get(user).copied().unwrap_or(0.0));
        if self.user_id.is_some() && current < 1.0 {
            self.user_id = None;
        }
        if let Some(best) = best
            && (self.user_id.is_none() || self.scores[&best] > current)
        {
            self.user_id = Some(best);
        }
    }

    /// The user's voice, when known.
    pub fn user(&mut self) -> Option<UserVoice> {
        let kept = self.kept_user();
        let named = match (&self.user_id, self.voices) {
            (Some(id), Some(voices)) => Some(UserVoice {
                voices: Some(voices),
                id: Some(id.clone()),
                prints: None,
            }),
            _ => None,
        };
        match (named, kept) {
            (None, kept) => kept,
            (Some(named), Some(kept)) => Some(UserVoice {
                prints: kept.prints,
                ..named
            }),
            (Some(named), None) => Some(named),
        }
    }

    /// The prints kept of the user, for a new call.
    pub fn kept_user(&mut self) -> Option<UserVoice> {
        let prints: Vec<Vec<f64>> = self
            .library
            .as_mut()?
            .user()
            .map(|user| {
                user.prints
                    .iter()
                    .map(|kept| round_print(&kept.print))
                    .collect()
            })
            .unwrap_or_default();
        (!prints.is_empty()).then_some(UserVoice {
            prints: Some(prints),
            ..UserVoice::default()
        })
    }

    /// Whether an utterance is clearly another voice than the user's.
    pub fn is_other(&mut self, tag: Option<&VoiceTag>) -> bool {
        let Some(tag) = tag else {
            return false;
        };
        if Some(tag.voices) != self.voices {
            return false;
        }
        let user = self.user_id.clone();
        if let Some(user) = &user
            && tag.mix.iter().any(|(id, _)| id == user)
        {
            return false;
        }
        if let Some(known) = self.profile_of(tag.id.as_deref())
            && known.role != VoiceRole::User
            && known.role != VoiceRole::Unknown
        {
            return true;
        }
        let Some(user) = user else {
            return false;
        };
        if tag.id.as_deref() == Some(user.as_str()) {
            return false;
        }
        tag.similarity.get(&user).copied().unwrap_or(0.0) < OTHER
    }

    fn who(&mut self, id: &str) -> String {
        let profile = self.profile_of(Some(id));
        if self.user_id.as_deref() == Some(id)
            || profile
                .as_ref()
                .is_some_and(|profile| profile.role == VoiceRole::User)
        {
            let user_name = match &profile {
                Some(profile) => profile.name.clone(),
                None => self
                    .library
                    .as_mut()
                    .and_then(|library| library.user().and_then(|user| user.name.clone())),
            };
            return user_name.map_or_else(|| "you".into(), |name| format!("{name} (you)"));
        }
        profile
            .and_then(|profile| profile.name)
            .unwrap_or_else(|| id.to_owned())
    }

    fn person_score(&mut self, tag: &VoiceTag, profile: &VoiceProfile) -> Option<f64> {
        let print = tag
            .utterance
            .and_then(|utterance| self.utterances.get(&(utterance as u64)).cloned())
            .or_else(|| tag.print.clone())
            .or_else(|| {
                tag.id
                    .as_ref()
                    .and_then(|id| self.clusters.get(id))
                    .and_then(|cluster| cluster.print.clone())
            })?;
        profile_score(profile, &print, self.voices).or_else(|| profile_score(profile, &print, None))
    }

    /// The label of an utterance, for the companion; "" without a tag.
    pub fn label(&mut self, tag: Option<&VoiceTag>) -> String {
        let Some(tag) = tag else {
            return String::new();
        };
        let current = Some(tag.voices) == self.voices;
        let user = if current { self.user_id.clone() } else { None };
        let like = user.as_ref().map_or(String::new(), |user| {
            format!(", {} like you", score(tag.similarity.get(user).copied()))
        });
        let who = |this: &mut Self, id: &str| if current { this.who(id) } else { id.to_owned() };
        if tag.mixed && tag.mix.len() > 1 {
            let names: Vec<String> = tag.mix.iter().map(|(id, _)| id.clone()).collect();
            if let Some(user) = &user
                && names.contains(user)
            {
                let ordered: Vec<String> = std::iter::once(user.clone())
                    .chain(names.iter().filter(|id| *id != user).cloned())
                    .collect();
                let said: Vec<String> = ordered.iter().map(|id| who(self, id)).collect();
                return format!("mixed: {}", said.join(" + "));
            }
            let said: Vec<String> = names.iter().map(|id| who(self, id)).collect();
            return format!("mixed: {}{like}", said.join(" + "));
        }
        let Some(id) = tag.id.clone() else {
            return format!("voice unclear{like}");
        };
        if user.as_deref() == Some(id.as_str()) {
            let user = user.expect("user");
            return format!(
                "{} {}",
                who(self, &id),
                score(tag.similarity.get(&user).copied())
            );
        }
        let profile = if current {
            self.profile_of(Some(&id))
        } else {
            None
        };
        if let Some(profile) = &profile {
            if let Some(name) = &profile.name {
                return match self.person_score(tag, profile) {
                    None => name.clone(),
                    Some(close) => format!("{name} {}", score(Some(close))),
                };
            }
            let calls = profile.calls;
            return format!(
                "voice {id}, heard on {} call{}{like}",
                js::number_text(calls),
                if calls == 1.0 { "" } else { "s" }
            );
        }
        let maybe = if current {
            self.clusters
                .get(&id)
                .and_then(|cluster| cluster.maybe.clone())
        } else {
            None
        };
        if let Some((maybe, close)) = maybe
            && let Some(of) = self
                .library
                .as_mut()
                .and_then(|library| library.get(&maybe).cloned())
        {
            return format!(
                "voice {id}, maybe {} {}{like}",
                profile_name(&of),
                score(Some(close))
            );
        }
        let named = self
            .library
            .as_mut()
            .is_some_and(|library| library.profiles().iter().any(|each| each.name.is_some()));
        format!("voice {id}{}{like}", if named { ", unknown" } else { "" })
    }

    /// Every score behind the label, compact, for the companion to judge
    /// with; with `offer`, an unnamed voice heard on many calls is said to
    /// be worth asking about, once ever.
    pub fn detail(&mut self, tag: Option<&VoiceTag>, offer: bool) -> String {
        let Some(tag) = tag else {
            return String::new();
        };
        if Some(tag.voices) != self.voices {
            return String::new();
        }
        let mut parts: Vec<String> = Vec::new();
        let people = |this: &mut Self, list: &[(String, f64)]| -> String {
            list.iter()
                .filter_map(|(profile, value)| {
                    let known = this.library.as_mut()?.get(profile)?.clone();
                    Some(format!("{} {}", profile_name(&known), score(Some(*value))))
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut voices = Vec::new();
        for (id, share) in &tag.mix {
            let closest = self.clusters.get(id).map(|cluster| cluster.closest.clone());
            let close = closest.map_or(String::new(), |closest| people(self, &closest));
            let is = if self.profile_of(Some(id)).is_some()
                || self.user_id.as_deref() == Some(id.as_str())
            {
                format!(" is {}", self.who(id))
            } else {
                String::new()
            };
            voices.push(format!(
                "{id} {}%{is}{}",
                js::number_text(js::round(share * 100.0)),
                if close.is_empty() {
                    String::new()
                } else {
                    format!(" (closest: {close})")
                }
            ));
        }
        if !voices.is_empty() {
            parts.push(format!("voices in it: {}", voices.join("; ")));
        }
        let print = match tag.utterance {
            Some(utterance) => self.utterances.get(&(utterance as u64)).cloned(),
            None => tag.print.clone(),
        };
        if let (Some(print), true) = (print, self.library.is_some()) {
            let call = self.voices;
            let profiles = self.library.as_mut().expect("library").profiles();
            let mut scored: Vec<(String, f64)> = profiles
                .iter()
                .filter_map(|profile| {
                    profile_score(profile, &print, call)
                        .or_else(|| profile_score(profile, &print, None))
                        .map(|value| (profile.id.clone(), value))
                })
                .collect();
            scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(4);
            let words = people(self, &scored);
            if !words.is_empty() {
                parts.push(format!("the words against people known: {words}"));
            }
        }
        let mut call: Vec<(&String, &f64)> = tag.similarity.iter().collect();
        call.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
        let call = call
            .iter()
            .map(|(id, value)| format!("{id} {}", score(Some(**value))))
            .collect::<Vec<_>>()
            .join(", ");
        if !call.is_empty() {
            parts.push(format!("against this call's voices: {call}"));
        }
        if offer && self.library.is_some() {
            for (id, _) in &tag.mix {
                if let Some(profile) = self.profile_of(Some(id))
                    && profile.role == VoiceRole::Unknown
                    && !profile.offered
                    && profile.calls >= OFFER_CALLS
                {
                    self.library
                        .as_mut()
                        .expect("library")
                        .mark_offered(&profile.id);
                    parts.push(format!(
                        "voice {id} was heard on {} calls and has no name: you may ask once, when it fits, who it is",
                        js::number_text(profile.calls)
                    ));
                }
            }
        }
        parts.join(" | ")
    }
}

fn profile_name(profile: &VoiceProfile) -> String {
    if profile.role == VoiceRole::User {
        return profile
            .name
            .as_ref()
            .map_or_else(|| "you".into(), |name| format!("{name} (you)"));
    }
    profile.name.clone().unwrap_or_else(|| {
        format!(
            "an unnamed voice ({} calls)",
            js::number_text(profile.calls)
        )
    })
}

#[cfg(test)]
mod tests;
