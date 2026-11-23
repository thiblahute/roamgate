//! server/src/cli/reviews.test.ts, case for case.

use std::collections::HashMap;
use std::sync::Arc;

use roamgate_base::secrets::without_secrets;
use serde_json::json;

use super::*;

/// 2026-11-16T12:00:00Z.
const NOW: f64 = 1_794_830_400_000.0;

struct Seeded {
    home: tempfile::TempDir,
    runtime: CliRuntime,
    data: PathBuf,
}

impl Seeded {
    fn run(&self, args: &[&str]) -> Printed {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        ReviewsCli {
            runtime: &self.runtime,
            now: &|| NOW,
        }
        .run(&args)
    }

    fn path(&self, name: &str) -> String {
        self.home.path().join(name).display().to_string()
    }

    fn read(&self, path: impl AsRef<Path>) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn settings(&self) -> Value {
        serde_json::from_str(&self.read(self.data.join("settings.json"))).unwrap()
    }

    fn effort_file(&self, name: &str) -> PathBuf {
        self.data
            .join("mr-reviews")
            .join("efforts")
            .join("e1")
            .join(name)
    }
}

/// A home with settings.json and one effort's files, as the server leaves
/// them.
fn seeded() -> Seeded {
    let home = tempfile::tempdir().unwrap();
    let data = home.path().join(".config").join("roamgate");
    let effort = data.join("mr-reviews").join("efforts").join("e1");
    std::fs::create_dir_all(&effort).unwrap();
    std::fs::write(
        data.join("settings.json"),
        json!({
            "theme": "dark",
            "gitlab_token": "glpat-abcdefghijklmnopqrstu",
            "mr_reviews": {
                "hosts": [{"host": "gitlab.example.org", "provider": "gitlab"}],
                "followed": [
                    {"host": "gitlab.example.org", "provider": "gitlab", "project": "g/p"}
                ],
                "hints": "I maintain g/p; my token ghp_abcdefghijklmnopqrstuvwx1234",
                "clones": {
                    "gitlab.example.org/g/p": {"connection_id": "local", "path": "/x"}
                },
                "order_version": 7,
                "order": [
                    "gitlab:gitlab.example.org/g/p#2",
                    "gitlab:gitlab.example.org/g/p#1"
                ],
                "overrides": {
                    "gitlab:gitlab.example.org/g/p#1": {
                        "next": "Ask bob, token glpat-abcdefghijklmnopqrstu",
                        "at": "2026-11-10T00:00:00Z",
                        "by": "user",
                        "marker": "m"
                    }
                },
                "views": [{"name": "media", "query": "project:media/*"}],
                "efforts": [{
                    "id": "e1",
                    "group": "g1",
                    "name": "Big",
                    "clone": {"connection_id": "local", "path": "/clone"},
                    "source": "refs/heads/big",
                    "target": {"remote": "origin", "branch": "main"}
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        effort.join("ledger.json"),
        json!({
            "version": 3,
            "entries": {
                "k1": {
                    "disposition": "not_for_upstream",
                    "reason": "debug",
                    "subject": "x",
                    "authorDate": 1,
                    "sha": "a",
                    "at": "2026-11-10T00:00:00Z",
                    "by": "user"
                }
            },
            "aliases": {},
            "matches": {},
            "plans": [],
            "journal": [{"id": 1, "at": "", "by": "user", "summary": "s", "before": {}}]
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        effort.join("derived.json"),
        json!({"commits": [{"subject": "derived"}]}).to_string(),
    )
    .unwrap();
    std::fs::write(
        effort.join("history.jsonl"),
        format!("{}\n", json!({"key": "k1", "sha": "a", "where": "source"})),
    )
    .unwrap();
    let runtime = CliRuntime {
        platform: "linux".into(),
        arch: "x64".into(),
        home: home.path().into(),
        app_data: None,
        exec_path: home.path().join("bin").join("roamgate"),
        version: "1.2.3".into(),
        standalone: true,
        uid: Some(1000),
        env: Arc::new(HashMap::<String, String>::new()),
    };
    Seeded {
        home,
        runtime,
        data,
    }
}

fn keys(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect()
}

#[test]
fn export_the_authored_state_only_key_sorted_stable_without_secrets() {
    let seeded = seeded();
    let printed = seeded.run(&["export"]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    let text = printed.stdout.trim_end_matches('\n').to_owned();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        keys(&value["mr_reviews"]),
        [
            "efforts",
            "followed",
            "hints",
            "hosts",
            "order",
            "overrides",
            "views"
        ]
    );
    // The hosts, followed projects and hints too (D30), a secret masked.
    assert_eq!(
        value["mr_reviews"]["hosts"],
        json!([{"host": "gitlab.example.org", "provider": "gitlab"}])
    );
    assert_eq!(
        value["mr_reviews"]["followed"],
        json!([{"host": "gitlab.example.org", "provider": "gitlab", "project": "g/p"}])
    );
    assert_eq!(
        value["mr_reviews"]["hints"],
        "I maintain g/p; my token [removed]"
    );
    assert!(!text.contains("ghp_"));
    // Not the clones, version, theme; nor derived data or the Undo journal.
    for absent in ["clones", "order_version", "derived", "journal"] {
        assert!(!text.contains(absent), "{absent}");
    }
    assert_eq!(
        value["efforts"]["e1"]["history"],
        json!([{"key": "k1", "sha": "a", "where": "source"}])
    );
    // No secret reaches it, by key or by value.
    assert!(!text.contains("glpat-"));
    assert!(text.contains("Ask bob, token [removed]"));
    assert_eq!(value["exported_at"], "2026-11-16T12:00:00.000Z");
    // Stable: the same state gives the same text.
    let out = seeded.path("out.json");
    let printed = seeded.run(&["export", "--out", &out]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    assert_eq!(
        printed.stdout,
        "Wrote the Reviews export to ~/out.json\n".to_owned()
    );
    assert_eq!(seeded.read(&out), format!("{text}\n"));
    assert!(text.find("\"efforts\"").unwrap() < text.find("\"exported_at\"").unwrap());
}

#[test]
fn secrets_are_dropped_by_key_and_masked_by_value_at_any_depth() {
    let value = without_secrets(&json!({
        "a": {
            "api_key": "x",
            "Password": "y",
            "note": "ghp_abcdefghijklmnopqrstuvwx1234"
        },
        "list": [{"authorization": "Bearer z", "author": "kept"}],
        "pem": "-----BEGIN OPENSSH PRIVATE KEY-----"
    }));
    assert_eq!(
        value,
        json!({
            "a": {"note": "[removed]"},
            "list": [{"author": "kept"}],
            "pem": "[removed]"
        })
    );
}

#[test]
fn import_what_it_would_change_nothing_without_apply_then_applied() {
    let seeded = seeded();
    let mine = seeded.path("mine.json");
    assert_eq!(seeded.run(&["export", "--out", &mine]).code, 0);
    let exported = parse_reviews_export(&seeded.read(&mine)).unwrap();
    let mut incoming = exported.clone();
    let key = "gitlab:gitlab.example.org/g/p#1";
    incoming.mr_reviews.insert("order".into(), json!([key]));
    {
        let over = &mut incoming.mr_reviews["overrides"][key];
        over["at"] = json!("2026-11-01T00:00:00Z");
        over["next"] = json!("Older");
    }
    incoming.mr_reviews.insert("views".into(), json!([]));
    incoming.mr_reviews.insert(
        "pinned".into(),
        json!([{"provider": "gitlab", "host": "gitlab.example.org", "project": "g/p", "number": 9}]),
    );
    incoming.mr_reviews.insert(
        "hosts".into(),
        json!([
            {"host": "gitlab.example.org", "provider": "gitlab"},
            {"host": "github.com", "provider": "github"}
        ]),
    );
    incoming.mr_reviews.insert("followed".into(), json!([]));
    incoming
        .mr_reviews
        .insert("hints".into(), json!("I maintain g/p and g/q"));
    incoming.efforts["e1"]["ledger"]["entries"] = json!({});
    incoming.efforts["e1"]["history"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "k1", "sha": "b", "where": "source"}));
    let theirs = seeded.path("theirs.json");
    std::fs::write(&theirs, stable_json(&incoming.to_value())).unwrap();
    let changes: Vec<(&str, String, bool)> = import_changes(&exported, &incoming)
        .into_iter()
        .map(|change| {
            let kind = match change.kind {
                ChangeKind::Added => "added",
                ChangeKind::Removed => "removed",
                ChangeKind::Changed => "changed",
            };
            (kind, change.path, change.newer_local)
        })
        .collect();
    let expected = [
        ("removed", "efforts.e1.entries.k1", false),
        ("changed", "efforts.e1.history", false),
        (
            "removed",
            "mr_reviews.followed[gitlab:gitlab.example.org/g/p]",
            false,
        ),
        ("changed", "mr_reviews.hints", false),
        ("added", "mr_reviews.hosts[github:github.com]", false),
        ("changed", "mr_reviews.order", false),
        (
            "changed",
            "mr_reviews.overrides.gitlab:gitlab.example.org/g/p#1",
            true,
        ),
        (
            "added",
            "mr_reviews.pinned[gitlab:gitlab.example.org/g/p#9]",
            false,
        ),
        ("removed", "mr_reviews.views[media]", false),
    ]
    .map(|(kind, path, newer)| (kind, path.to_owned(), newer));
    assert_eq!(changes, expected);
    let before = seeded.read(seeded.data.join("settings.json"));
    let printed = seeded.run(&["import", &theirs]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    assert!(
        printed
            .stdout
            .contains("~ mr_reviews.overrides.gitlab:gitlab.example.org/g/p#1  (yours is newer)")
    );
    assert_eq!(
        printed.stdout.lines().last(),
        Some("9 changes; --apply to make them.")
    );
    assert_eq!(seeded.read(seeded.data.join("settings.json")), before);
    let printed = seeded.run(&["import", &theirs, "--apply"]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    assert_eq!(
        printed.stdout.lines().last(),
        Some("Applied 9 changes (1 effort ledger).")
    );
    let settings = seeded.settings();
    assert_eq!(settings["theme"], "dark");
    assert_eq!(settings["mr_reviews"]["order"], json!([key]));
    assert_eq!(settings["mr_reviews"]["views"], json!([]));
    assert_eq!(settings["mr_reviews"]["hosts"].as_array().unwrap().len(), 2);
    assert!(
        settings["mr_reviews"]
            .get("followed")
            .is_none_or(|followed| followed == &json!([]))
    );
    assert_eq!(settings["mr_reviews"]["hints"], "I maintain g/p and g/q");
    assert!(settings["mr_reviews"].get("clones").is_some());
    assert_eq!(settings["mr_reviews"]["order_version"], 8);
    let ledger: Value =
        serde_json::from_str(&seeded.read(seeded.effort_file("ledger.json"))).unwrap();
    assert_eq!(ledger["entries"], json!({}));
    assert_eq!(ledger["journal"], json!([]));
    assert_eq!(ledger["version"], 4);
    assert_eq!(
        seeded
            .read(seeded.effort_file("history.jsonl"))
            .trim()
            .split('\n')
            .count(),
        2
    );
    // Once applied, nothing more would change.
    let after = export_reviews(
        settings.get("mr_reviews"),
        &seeded.data.join("mr-reviews").join("efforts"),
        NOW,
    );
    assert_eq!(import_changes(&after, &incoming), []);
    // Anything else is refused.
    let bad = seeded.path("bad.json");
    std::fs::write(&bad, r#"{"format":"other"}"#).unwrap();
    let printed = seeded.run(&["import", &bad]);
    assert_eq!(printed.code, 1);
    assert!(
        printed
            .stderr
            .lines()
            .last()
            .unwrap()
            .contains("not a Reviews export")
    );
}

#[test]
fn import_of_a_version_1_export_keeps_the_hosts_followed_projects_and_hints() {
    let seeded = seeded();
    let mine = seeded.path("mine.json");
    assert_eq!(seeded.run(&["export", "--out", &mine]).code, 0);
    let mut old: Value = serde_json::from_str(&seeded.read(&mine)).unwrap();
    old["version"] = json!(1);
    let reviews = old["mr_reviews"].as_object_mut().unwrap();
    for key in ["hosts", "followed", "hints"] {
        reviews.shift_remove(key);
    }
    let old_path = seeded.path("old.json");
    std::fs::write(&old_path, stable_json(&old)).unwrap();
    let local = parse_reviews_export(&seeded.read(&mine)).unwrap();
    assert_eq!(
        import_changes(&local, &parse_reviews_export(&stable_json(&old)).unwrap()),
        []
    );
    let printed = seeded.run(&["import", &old_path, "--apply"]);
    assert_eq!(printed.code, 0, "{}", printed.stderr);
    let settings = seeded.settings();
    assert_eq!(
        settings["mr_reviews"]["hosts"],
        json!([{"host": "gitlab.example.org", "provider": "gitlab"}])
    );
    assert_eq!(
        settings["mr_reviews"]["followed"].as_array().unwrap().len(),
        1
    );
    assert!(
        settings["mr_reviews"]["hints"]
            .as_str()
            .unwrap()
            .contains("I maintain g/p")
    );
}

#[test]
fn usage_errors_and_help() {
    let seeded = seeded();
    let printed = seeded.run(&[]);
    assert_eq!((printed.code, printed.stdout.as_str()), (0, REVIEWS_HELP));
    let printed = seeded.run(&["export", "--out"]);
    assert_eq!(
        (printed.code, printed.stderr.as_str()),
        (2, "--out needs a file\n")
    );
    let printed = seeded.run(&["import"]);
    assert_eq!(
        (printed.code, printed.stderr.as_str()),
        (2, "Usage: roamgate reviews import FILE [--apply]\n")
    );
    let printed = seeded.run(&["import", "missing.json"]);
    assert_eq!(printed.code, 1);
    assert!(
        printed
            .stderr
            .starts_with("missing.json: ENOENT: no such file or directory, open '")
    );
    let printed = seeded.run(&["frob"]);
    assert_eq!(
        (printed.code, printed.stderr.as_str()),
        (2, "Unknown reviews action: frob\n")
    );
}
