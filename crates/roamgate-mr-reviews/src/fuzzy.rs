//! Fuzzy matches of an effort's commits against the upstream commits since
//! their merge base (`mr-reviews/fuzzy.ts`, D14): scored locally, subject
//! words by their rarity, touched paths, the author and the size of the
//! change on shared files.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

pub const MATCH_THRESHOLD: f64 = 0.42;
pub const MATCH_TOP: usize = 3;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MatchCommit {
    pub key: String,
    pub subject: String,
    pub author: String,
    pub files: Vec<String>,
    /// Lines changed per file, aligned with files.
    pub sizes: Option<Vec<f64>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct UpstreamCandidate {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub at: f64,
    pub files: Vec<String>,
    pub sizes: Vec<f64>,
}

impl UpstreamCandidate {
    pub fn to_json(&self) -> Value {
        json!({"sha": self.sha, "at": roamgate_agents::js::number(self.at), "author": self.author,
            "subject": self.subject, "files": self.files,
            "sizes": self.sizes.iter().map(|s| roamgate_agents::js::number(*s)).collect::<Vec<_>>()})
    }
}

/// `MrMatchProposal`.
#[derive(Clone, Debug, PartialEq)]
pub struct Proposal {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub score: f64,
    pub why: String,
}

impl Proposal {
    pub fn to_json(&self) -> Value {
        json!({"sha": self.sha, "subject": self.subject, "author": self.author,
            "score": roamgate_agents::js::number(self.score), "why": self.why})
    }
}

const STOP: &[&str] = &[
    "a", "an", "and", "the", "of", "to", "in", "on", "for", "with", "from", "by", "at", "is", "be",
    "it", "as", "or", "not", "no", "this", "that", "into", "when", "add", "fix", "use", "make",
    "update", "remove", "more", "less", "don't", "do",
];

static MARKER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:fixup|squash|amend)! ").expect("pattern"));
static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9_]+").expect("pattern"));

/// A subject's words: lower case, no prefix markers, no stop words.
pub fn subject_words(subject: &str) -> Vec<String> {
    let lower = MARKER.replace(subject, "").to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for word in SPLIT.split(&lower) {
        if word.len() >= 2 && !STOP.contains(&word) && !out.iter().any(|w| w == word) {
            out.push(word.to_owned());
        }
    }
    out
}

fn dir_of(file: &str) -> &str {
    file.rfind('/').map_or(".", |at| &file[..at])
}

fn jaccard<T: std::hash::Hash + Eq>(a: &HashSet<T>, b: &HashSet<T>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let shared = a.iter().filter(|x| b.contains(*x)).count() as f64;
    shared / (a.len() as f64 + b.len() as f64 - shared)
}

/// Scores one pair: 0 to 1, with what made it close.
pub fn score_pair(
    commit: &MatchCommit,
    candidate: &UpstreamCandidate,
    idf: &dyn Fn(&str) -> f64,
) -> (f64, Vec<&'static str>) {
    let mut why = Vec::new();
    let files: HashSet<&str> = commit.files.iter().map(String::as_str).collect();
    let theirs: HashSet<&str> = candidate.files.iter().map(String::as_str).collect();
    let file_score = jaccard(&files, &theirs);
    let dir_score = jaccard(
        &commit.files.iter().map(|f| dir_of(f)).collect(),
        &candidate.files.iter().map(|f| dir_of(f)).collect(),
    );
    let paths = file_score.max(dir_score * 0.5);
    if file_score >= 0.5 {
        why.push("same files");
    } else if file_score > 0.0 {
        why.push("some files");
    } else if dir_score > 0.0 {
        why.push("same directories");
    }
    let mine = subject_words(&commit.subject);
    let other = subject_words(&candidate.subject);
    let mut union: Vec<&String> = Vec::new();
    for word in mine.iter().chain(other.iter()) {
        if !union.contains(&word) {
            union.push(word);
        }
    }
    let (mut shared, mut all) = (0.0, 0.0);
    for word in union {
        let weight = idf(word);
        all += weight;
        if other.contains(word) && mine.contains(word) {
            shared += weight;
        }
    }
    let words = if all != 0.0 { shared / all } else { 0.0 };
    if words >= 0.5 {
        why.push("subject");
    } else if words > 0.2 {
        why.push("subject words");
    }
    let author = if commit.author.trim().to_lowercase() == candidate.author.trim().to_lowercase() {
        1.0
    } else {
        0.0
    };
    if author != 0.0 {
        why.push("author");
    }
    let (mut size, mut counted) = (0.0, 0.0);
    for (index, file) in commit.files.iter().enumerate() {
        let Some(at) = candidate.files.iter().position(|f| f == file) else {
            continue;
        };
        let a = commit
            .sizes
            .as_ref()
            .and_then(|s| s.get(index))
            .copied()
            .unwrap_or(0.0);
        let b = candidate.sizes.get(at).copied().unwrap_or(0.0);
        counted += 1.0;
        size += if a != 0.0 || b != 0.0 {
            1.0 - (a - b).abs() / a.max(b)
        } else {
            1.0
        };
    }
    let sizes = if counted != 0.0 { size / counted } else { 0.0 };
    if sizes >= 0.8 {
        why.push("size");
    }
    (
        0.35 * paths + 0.35 * words + 0.1 * author + 0.2 * sizes,
        why,
    )
}

/// The best candidates of each commit above the threshold, best first, by
/// commit key (in commit order); rejected candidates never come back.
pub fn propose_matches(
    commits: &[MatchCommit],
    candidates: &[UpstreamCandidate],
    rejected: &dyn Fn(&str) -> Vec<String>,
    threshold: Option<f64>,
    top: Option<usize>,
) -> Vec<(String, Vec<Proposal>)> {
    let threshold = threshold.unwrap_or(MATCH_THRESHOLD);
    let top = top.unwrap_or(MATCH_TOP);
    let mut out: Vec<(String, Vec<Proposal>)> = Vec::new();
    if commits.is_empty() || candidates.is_empty() {
        return out;
    }
    let mut df: HashMap<String, f64> = HashMap::new();
    let mut by_word: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_file: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_dir: HashMap<&str, Vec<usize>> = HashMap::new();
    for (at, candidate) in candidates.iter().enumerate() {
        for word in subject_words(&candidate.subject) {
            *df.entry(word.clone()).or_default() += 1.0;
            by_word.entry(word).or_default().push(at);
        }
        let mut seen: HashSet<&str> = HashSet::new();
        for file in &candidate.files {
            if seen.insert(file) {
                by_file.entry(file).or_default().push(at);
            }
        }
        let mut dirs: HashSet<&str> = HashSet::new();
        for file in &candidate.files {
            let dir = dir_of(file);
            if dirs.insert(dir) {
                by_dir.entry(dir).or_default().push(at);
            }
        }
    }
    let total = candidates.len() as f64;
    let idf = |word: &str| (1.0 + total / (1.0 + df.get(word).copied().unwrap_or(0.0))).ln();
    let rare = (total / 10.0).max(5.0);
    for commit in commits {
        let mut pool: Vec<usize> = Vec::new();
        let mut in_pool: HashSet<usize> = HashSet::new();
        let mut add = |at: usize| {
            if in_pool.insert(at) {
                pool.push(at);
            }
        };
        for file in &commit.files {
            for at in by_file.get(file.as_str()).into_iter().flatten() {
                add(*at);
            }
        }
        let mut dirs: Vec<&str> = Vec::new();
        for file in &commit.files {
            let dir = dir_of(file);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        for dir in dirs {
            for at in by_dir.get(dir).into_iter().flatten().take(2000) {
                add(*at);
            }
        }
        for word in subject_words(&commit.subject) {
            if df.get(&word).copied().unwrap_or(0.0) <= rare {
                for at in by_word.get(&word).into_iter().flatten() {
                    add(*at);
                }
            }
        }
        let no: HashSet<String> = rejected(&commit.key).into_iter().collect();
        let mut scored: Vec<Proposal> = Vec::new();
        for at in pool {
            let candidate = &candidates[at];
            if no.contains(&candidate.sha) {
                continue;
            }
            let (score, why) = score_pair(commit, candidate, &idf);
            if score >= threshold {
                scored.push(Proposal {
                    sha: candidate.sha.clone(),
                    subject: candidate.subject.clone(),
                    author: candidate.author.clone(),
                    score: (score * 100.0 + 0.5).floor() / 100.0,
                    why: why.join(", "),
                });
            }
        }
        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if !scored.is_empty() {
            scored.truncate(top);
            out.push((commit.key.clone(), scored));
        }
    }
    out
}

static COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+|-)$").expect("pattern"));

fn number(text: &str) -> f64 {
    let n = roamgate_agents::js::number_from_text(text);
    if n.is_nan() { 0.0 } else { n }
}

/// `git log --numstat` lines: `C sha at author subject`, then `add del path`;
/// `Q sha` for an exact match. The candidates (exact ones left out) and the exact shas.
pub fn parse_upstream_candidates(stdout: &str) -> (Vec<UpstreamCandidate>, Vec<String>) {
    let mut commits: Vec<UpstreamCandidate> = Vec::new();
    let mut exact: Vec<String> = Vec::new();
    let mut current: Option<usize> = None;
    for line in stdout.split('\n') {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts[0] == "C" && parts.len() >= 5 {
            commits.push(UpstreamCandidate {
                sha: parts[1].to_owned(),
                at: number(parts[2]),
                author: parts[3].to_owned(),
                subject: parts[4..].join("\t"),
                files: vec![],
                sizes: vec![],
            });
            current = Some(commits.len() - 1);
        } else if parts[0] == "Q" && parts.len() == 2 {
            if !exact.iter().any(|e| e == parts[1]) {
                exact.push(parts[1].to_owned());
            }
            current = None;
        } else if let Some(at) = current
            && parts.len() == 3
            && COUNT.is_match(parts[0])
        {
            let commit = &mut commits[at];
            if commit.files.len() < 20 {
                commit.files.push(parts[2].to_owned());
                commit.sizes.push(number(parts[0]) + number(parts[1]));
            }
        }
    }
    commits.retain(|c| !exact.contains(&c.sha));
    (commits, exact)
}

/// Upstream commits since the merge base, at most `max`, and those already matched exactly.
pub fn upstream_candidates_script(
    dir: &str,
    source: &str,
    target: &str,
    merge_base: &str,
    max: usize,
    sh_quote: &dyn Fn(&str) -> String,
) -> String {
    let range = format!("{merge_base}..{target}");
    [
        format!("d={}", sh_quote(dir)),
        format!("git -C \"$d\" log --no-merges -n {max} --format='C%x09%H%x09%at%x09%an%x09%s' --numstat {}", sh_quote(&range)),
        format!(
            "git -C \"$d\" cherry {} {} {} | awk '$1 == \"-\" {{ print \"Q\\t\" $2 }}'",
            sh_quote(source),
            sh_quote(target),
            sh_quote(merge_base)
        ),
        "exit 0".to_owned(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(sha: &str, subject: &str, files: &[&str], sizes: Option<&[f64]>) -> UpstreamCandidate {
        UpstreamCandidate {
            sha: sha.into(),
            subject: subject.into(),
            author: "Ann".into(),
            at: 0.0,
            files: files.iter().map(|f| (*f).into()).collect(),
            sizes: sizes.map_or_else(|| files.iter().map(|_| 10.0).collect(), <[f64]>::to_vec),
        }
    }

    fn commit(
        key: &str,
        subject: &str,
        author: &str,
        files: &[&str],
        sizes: &[f64],
    ) -> MatchCommit {
        MatchCommit {
            key: key.into(),
            subject: subject.into(),
            author: author.into(),
            files: files.iter().map(|f| (*f).into()).collect(),
            sizes: Some(sizes.to_vec()),
        }
    }

    fn none(_: &str) -> Vec<String> {
        vec![]
    }

    fn get<'a>(out: &'a [(String, Vec<Proposal>)], key: &str) -> Option<&'a Vec<Proposal>> {
        out.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    #[test]
    fn subject_words_drop_markers_stop_words_and_punctuation() {
        assert_eq!(
            subject_words("fixup! pool: Add the buffer-pool to the sink"),
            ["pool", "buffer", "sink"]
        );
    }

    #[test]
    fn a_reworded_commit_upstream_is_proposed_first_noise_is_not() {
        let mut candidates = vec![
            up(
                "aaa1111",
                "bufferpool: allocate buffers lazily in the sink",
                &["gst/pool/pool.c", "gst/pool/pool.h"],
                None,
            ),
            up("bbb2222", "docs: typo", &["docs/README.md"], None),
            up(
                "ccc3333",
                "pool: refactor locking",
                &["gst/pool/pool.c"],
                Some(&[400.0]),
            ),
        ];
        for index in 0..50 {
            candidates.push(up(
                &format!("fff{index}"),
                &format!("misc change {index}"),
                &[&format!("other/{index}.c")],
                None,
            ));
        }
        let out = propose_matches(
            &[
                commit(
                    "k1",
                    "pool: allocate buffers lazily",
                    "ann",
                    &["gst/pool/pool.c", "gst/pool/pool.h"],
                    &[10.0, 10.0],
                ),
                commit(
                    "k2",
                    "Something unrelated entirely",
                    "Bob",
                    &["tools/x.py"],
                    &[3.0],
                ),
            ],
            &candidates,
            &none,
            None,
            None,
        );
        let k1 = get(&out, "k1").unwrap();
        assert_eq!(k1[0].sha, "aaa1111");
        assert!(k1[0].why.contains("same files"));
        assert!(k1[0].score > 0.7);
        assert!(k1.len() <= 3);
        assert!(!k1.iter().any(|p| p.sha == "bbb2222"));
        assert!(get(&out, "k2").is_none());
    }

    #[test]
    fn a_rejected_candidate_is_never_proposed_again() {
        let candidates = vec![
            up(
                "aaa1111",
                "pool: allocate buffers lazily",
                &["a/pool.c"],
                None,
            ),
            up(
                "aaa2222",
                "pool: allocate buffers lazily again",
                &["a/pool.c"],
                None,
            ),
        ];
        let c = commit(
            "k1",
            "pool: allocate buffers lazily",
            "Ann",
            &["a/pool.c"],
            &[10.0],
        );
        assert_eq!(
            get(
                &propose_matches(std::slice::from_ref(&c), &candidates, &none, None, None),
                "k1"
            )
            .unwrap()[0]
                .sha,
            "aaa1111"
        );
        let rejected = |key: &str| {
            if key == "k1" {
                vec!["aaa1111".to_owned()]
            } else {
                vec![]
            }
        };
        let after = propose_matches(&[c], &candidates, &rejected, None, None);
        assert_eq!(
            get(&after, "k1")
                .unwrap()
                .iter()
                .map(|p| p.sha.as_str())
                .collect::<Vec<_>>(),
            ["aaa2222"]
        );
    }

    #[test]
    fn commits_2000_against_3000_candidates_stay_quick() {
        let candidates: Vec<UpstreamCandidate> = (0..3000)
            .map(|i| {
                up(
                    &format!("u{i}"),
                    &format!("area{}: change number {i} of the thing", i % 40),
                    &[
                        &format!("dir{}/file{}.c", i % 40, i % 300),
                        &format!("dir{}/x.h", i % 40),
                    ],
                    None,
                )
            })
            .collect();
        let commits: Vec<MatchCommit> = (0..2000)
            .map(|i| {
                commit(
                    &format!("k{i}"),
                    &format!("area{}: change number {i} of the thing", i % 40),
                    "Ann",
                    &[&format!("dir{}/file{}.c", i % 40, i % 300)],
                    &[10.0],
                )
            })
            .collect();
        let started = std::time::Instant::now();
        let out = propose_matches(&commits, &candidates, &none, None, None);
        assert!(started.elapsed().as_secs() < 15);
        assert_eq!(get(&out, "k5").unwrap()[0].sha, "u5");
    }

    #[test]
    fn upstream_candidates_parse_with_their_sizes_exact_matches_are_left_out() {
        let text = [
            "C\taaa\t100\tAnn\tpool: x",
            "",
            "3\t1\tgst/pool.c",
            "-\t-\tlogo.png",
            "C\tbbb\t90\tBob\tdocs",
            "",
            "1\t0\tREADME",
            "Q\tbbb",
        ]
        .join("\n");
        let (commits, exact) = parse_upstream_candidates(&text);
        assert_eq!(
            commits
                .iter()
                .map(UpstreamCandidate::to_json)
                .collect::<Vec<_>>(),
            vec![
                json!({"sha": "aaa", "at": 100, "author": "Ann", "subject": "pool: x",
                "files": ["gst/pool.c", "logo.png"], "sizes": [4, 0]})
            ]
        );
        assert_eq!(exact, ["bbb"]);
    }
}
