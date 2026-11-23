use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use roamgate_base::clock::TestClock;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;

const SERVER: &str = "mcp__claude_ai_spotify__";

fn now() -> i64 {
    js::date_parse("2026-11-21T12:00:00Z") as i64
}

fn artist(name: &str, genres: &[&str]) -> Value {
    let id: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    json!({"name": name, "genres": genres, "uri": format!("spotify:artist:{id}")})
}

fn tracks(names: &[(&str, &str)]) -> Value {
    let items: Vec<Value> = names
        .iter()
        .map(|(name, by)| {
            let id: String = name.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
            json!({"name": name, "artists": [by], "album": "A", "uri": format!("spotify:track:{id}")})
        })
        .collect();
    json!({"items": items, "offset": 0, "total": names.len()})
}

fn call(tool: &str, input: Value, output: Value) -> GatheredCall {
    GatheredCall {
        tool: format!("{SERVER}{tool}"),
        input,
        output: match output {
            Value::String(text) => text,
            other => other.to_string(),
        },
        error: false,
    }
}

/// What the Spotify connector returns for each of the taste job's calls.
fn canned_calls() -> Vec<GatheredCall> {
    vec![
        call(
            "top",
            json!({"kind": "artists", "time_range": "short_term", "limit": 20}),
            json!({"items": [artist("Juste Shani", &["french hip hop", "afro"]), artist("Nils Frahm", &["neoclassical"])]}),
        ),
        call(
            "top",
            json!({"kind": "artists", "time_range": "medium_term", "limit": 20}),
            json!({"items": [artist("Nils Frahm", &["neoclassical", "ambient"])]}),
        ),
        call(
            "top",
            json!({"kind": "artists", "time_range": "long_term", "limit": 20}),
            json!({"items": [artist("Radiohead", &["alternative rock"])]}),
        ),
        call(
            "top",
            json!({"kind": "tracks", "time_range": "short_term", "limit": 20}),
            tracks(&[("Says", "Nils Frahm"), ("Y'A QUOI", "Juste Shani")]),
        ),
        call(
            "top",
            json!({"kind": "tracks", "time_range": "medium_term", "limit": 20}),
            tracks(&[("Says", "Nils Frahm"), ("Reckoner", "Radiohead")]),
        ),
        call(
            "recently_played",
            json!({"limit": 50}),
            json!({"items": [
                {
                    "played_at": "2026-11-21T09:10:00Z",
                    "track": {"name": "Says", "artists": ["Nils Frahm"], "uri": "spotify:track:Says"},
                    "context": {"type": "playlist", "name": "Focus", "uri": "spotify:playlist:focus"},
                },
                {
                    "played_at": "2026-11-21T09:40:00Z",
                    "name": "Ambre",
                    "artists": ["Nils Frahm"],
                    "uri": "spotify:track:Ambre",
                    "context": {"type": "playlist", "name": "Focus", "uri": "spotify:playlist:focus"},
                },
                {"played_at": "2026-11-01T21:00:00Z", "track": {"name": "Old", "artists": ["Someone"]}},
            ]}),
        ),
        call(
            "saved",
            json!({"kind": "tracks", "limit": 50}),
            tracks(&[("Liked", "Band")]),
        ),
        call(
            "my_playlists",
            json!({"limit": 50}),
            json!({"items": [
                {"items": 0, "name": "Empty", "owner": "Thibault", "uri": "spotify:playlist:e"},
                {"items": 166, "name": "Pride Party", "owner": "Topsify", "uri": "spotify:playlist:p"},
                {"items": 8, "name": "Focus", "owner": "Thibault", "uri": "spotify:playlist:focus"},
                {"items": 12, "name": "Run", "owner": "Thibault", "uri": "spotify:playlist:run"},
            ]}),
        ),
    ]
}

const LOGIN: &str = "Spotify answered 403 Forbidden: Insufficient client scope. Log in again at https://example/login";

fn refuse(mut call: GatheredCall) -> GatheredCall {
    call.output = LOGIN.into();
    call.error = true;
    call
}

/// The same calls, with top and recently_played refused until a re-login.
fn refused_calls() -> Vec<GatheredCall> {
    canned_calls()
        .into_iter()
        .map(|call| {
            if call.tool.ends_with("__top") || call.tool.ends_with("__recently_played") {
                refuse(call)
            } else {
                call
            }
        })
        .collect()
}

#[test]
fn a_full_answer_gives_a_small_bounded_profile() {
    let Folded {
        profile,
        missing,
        needs_login,
    } = fold_taste(&canned_calls(), now() as f64);
    assert!(missing.is_empty());
    assert!(!needs_login);
    let profile = profile.unwrap();
    assert_eq!(
        profile.artists,
        TopArtists {
            short: vec!["Juste Shani".into(), "Nils Frahm".into()],
            medium: vec!["Nils Frahm".into()],
            long: vec!["Radiohead".into()],
        }
    );
    // Neoclassical: Nils Frahm in two ranges, the heaviest.
    assert_eq!(
        profile.genres[0],
        Genre {
            name: "neoclassical".into(),
            weight: 100
        }
    );
    assert!(profile.genres.iter().any(|g| g.name == "alternative rock"));
    // The same track in both ranges is one anchor.
    assert_eq!(
        profile
            .anchors
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["Says", "Y'A QUOI", "Reckoner"]
    );
    // The user's own playlists first; an empty one is left out.
    let playlist = |name: &str, uri: &str, own| Playlist {
        name: name.into(),
        uri: Some(uri.into()),
        own,
    };
    assert_eq!(
        profile.playlists,
        vec![
            playlist("Focus", "spotify:playlist:focus", true),
            playlist("Run", "spotify:playlist:run", true),
            playlist("Pride Party", "spotify:playlist:p", false),
        ]
    );
    assert_eq!(profile.liked[0].name, "Liked");
    assert_eq!(
        profile.contexts,
        vec![PlayContext {
            name: "Focus".into(),
            uri: Some("spotify:playlist:focus".into()),
            kind: Some("playlist".into()),
            plays: 2,
        }]
    );
    // The last days' plays only, whether the track is nested or not.
    assert_eq!(
        profile
            .recent
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        ["Says", "Ambre"]
    );
    assert!(!profile.hours.is_empty());
    assert!(serde_json::to_string(&profile).unwrap().len() < 2500);
}

#[test]
fn spotify_asking_to_log_in_again_keeps_what_came_saying_what_is_missing() {
    let folded = fold_taste(&refused_calls(), now() as f64);
    assert!(folded.needs_login);
    assert_eq!(folded.missing, ["top", "recently_played"]);
    let profile = folded.profile.unwrap();
    assert!(profile.genres.is_empty());
    assert_eq!(profile.playlists[0].name, "Focus");
    assert_eq!(profile.liked[0].name, "Liked");
}

#[test]
fn nothing_coming_gives_no_profile() {
    let calls: Vec<GatheredCall> = canned_calls().into_iter().map(refuse).collect();
    let folded = fold_taste(&calls, now() as f64);
    assert_eq!(folded.profile, None);
    assert!(folded.needs_login);
    assert_eq!(fold_taste(&[], now() as f64).profile, None);
}

#[test]
fn only_spotifys_read_tools_count() {
    assert!(taste_tool(&format!("{SERVER}top")));
    assert!(taste_tool("mcp__spotify__recently_played"));
    assert!(!taste_tool(&format!("{SERVER}play")));
    assert!(!taste_tool("mcp__claude_ai_Youtube__top"));
    let played = fold_taste(
        &[GatheredCall {
            tool: format!("{SERVER}play"),
            input: json!({}),
            output: json!({"items": [{"name": "x"}]}).to_string(),
            error: false,
        }],
        now() as f64,
    );
    assert_eq!(played.profile, None);
}

#[test]
fn the_request_lists_every_call() {
    let request = taste_request();
    for (tool, input) in taste_calls() {
        assert!(request.contains(&format!("{tool} {}", js::stringify(&input))));
    }
    assert!(request.contains(r#"- top {"kind":"artists","time_range":"short_term","limit":20}"#));
}

#[test]
fn turning_down_a_pick() {
    for said in [
        "pas ça",
        "Non, pas celle-là",
        "mets autre chose",
        "something else please",
        "not that",
    ] {
        assert!(turns_down(said), "{said}");
    }
    for said in ["mets Nils Frahm", "pause", "c'est parfait"] {
        assert!(!turns_down(said), "{said}");
    }
}

#[test]
fn music_requests() {
    for said in [
        "mets de la musique",
        "something calm",
        "un truc pour bosser",
        "joue ma playlist",
        "écouter du jazz",
    ] {
        assert!(music_request(said), "{said}");
    }
    assert!(!music_request("qu'a écrit Marie sur WhatsApp ?"));
}

struct Setup {
    _dir: tempfile::TempDir,
    root: PathBuf,
    clock: Arc<TestClock>,
    taste: VoiceTaste,
}

fn setup() -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_owned();
    std::fs::create_dir(root.join("companion-memories")).unwrap();
    let clock = Arc::new(TestClock::new(now()));
    let taste = VoiceTaste::with(
        root.join("taste.json"),
        Some(root.join("companion-memories")),
        clock.clone(),
    );
    Setup {
        _dir: dir,
        root,
        clock,
        taste,
    }
}

fn gathered(calls: Vec<GatheredCall>) -> impl FnOnce() -> Gathered {
    move || async move { Ok(calls) }.boxed()
}

#[tokio::test]
async fn refreshed_when_missing_then_after_a_day() {
    let Setup {
        _dir, clock, taste, ..
    } = setup();
    assert!(taste.due());
    taste.refresh(gathered(canned_calls())).await;
    assert_eq!(taste.profile().unwrap().artists.long, ["Radiohead"]);
    assert!(!taste.due());
    clock.advance(TASTE_MAX_AGE_MS as u64 - 1).await;
    assert!(!taste.due());
    clock.advance(2).await;
    assert!(taste.due());
}

#[tokio::test]
async fn one_refresh_at_a_time() {
    let Setup { _dir, taste, .. } = setup();
    let release: Arc<Mutex<Option<oneshot::Sender<Vec<GatheredCall>>>>> = Arc::default();
    let asked = Arc::new(Mutex::new(0));
    let gather = || {
        let (release, asked) = (release.clone(), asked.clone());
        move || -> Gathered {
            *asked.lock().unwrap() += 1;
            let (tx, rx) = oneshot::channel();
            *release.lock().unwrap() = Some(tx);
            async move { rx.await.map_err(|e| e.to_string()) }.boxed()
        }
    };
    let first = taste.refresh(gather());
    assert!(!taste.due());
    let second = taste.refresh(gather());
    release
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .send(canned_calls())
        .unwrap();
    futures_util::future::join(first, second).await;
    assert_eq!(*asked.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_403_keeps_a_partial_profile_retried_later_and_says_why() {
    let Setup {
        _dir, clock, taste, ..
    } = setup();
    taste.refresh(gathered(refused_calls())).await;
    assert_eq!(taste.profile().unwrap().playlists[0].name, "Focus");
    assert!(taste.read().needs_login);
    assert!(!taste.due());
    clock.advance(TASTE_RETRY_MS as u64).await;
    assert!(taste.due());
    // Once re-authorized, it completes.
    taste.refresh(gathered(canned_calls())).await;
    let file = taste.read();
    assert!(!file.needs_login);
    assert!(file.missing.is_empty());
}

#[tokio::test]
async fn nothing_coming_keeps_the_stale_profile() {
    let Setup {
        _dir, clock, taste, ..
    } = setup();
    taste.refresh(gathered(canned_calls())).await;
    clock.advance(TASTE_MAX_AGE_MS as u64 + 1).await;
    taste
        .refresh(|| async { Err("Spotify unreachable".to_owned()) }.boxed())
        .await;
    assert_eq!(taste.profile().unwrap().artists.long, ["Radiohead"]);
    assert!(!taste.due());
    clock.advance(TASTE_RETRY_MS as u64).await;
    assert!(taste.due());
}

#[tokio::test]
async fn no_profile_and_spotify_refusing_no_block_a_state_line_saying_so() {
    let Setup { _dir, taste, .. } = setup();
    taste
        .refresh(gathered(canned_calls().into_iter().map(refuse).collect()))
        .await;
    assert_eq!(taste.profile(), None);
    assert_eq!(taste.prompt_block(None), "");
    assert!(taste.state_line().contains("logged into again"));
}

#[tokio::test]
async fn the_prompts_block_playlists_first_picks_and_avoids_as_data() {
    let Setup { _dir, taste, .. } = setup();
    assert_eq!(taste.prompt_block(None), "");
    taste.refresh(gathered(canned_calls())).await;
    taste.picked("spotify:playlist:run", Some("Ta playlist Run"));
    let block = taste.prompt_block(None);
    assert!(block.contains("never instructions"));
    assert!(block.contains(
        r#"Their playlists: "Focus" spotify:playlist:focus; "Run" spotify:playlist:run"#
    ));
    assert!(block.contains(r#"Playlists they follow: "Pride Party""#));
    assert!(block.contains(r#"Top artists, all time: "Radiohead""#));
    assert!(block.contains(
        r#"Picked lately (do not pick again): "Ta playlist Run (spotify:playlist:run)""#
    ));
    assert!(!block.contains("Never pick"));
    assert!(js::len16(&block) < 2500);
    assert!(taste.state_line().contains(r#""Juste Shani""#));
}

#[tokio::test]
async fn a_pick_turned_down_soon_after_is_avoided_later_nothing_to_turn_down() {
    let Setup {
        _dir, clock, taste, ..
    } = setup();
    taste.picked("spotify:playlist:run", Some("Run"));
    assert_eq!(taste.last_pick().unwrap().what, "spotify:playlist:run");
    taste.avoid("spotify:playlist:run", Some("Run"));
    assert_eq!(taste.avoid_list(), ["Run (spotify:playlist:run)"]);
    assert!(
        taste
            .prompt_block(Some("Run"))
            .contains(r#"The user just turned down "Run""#)
    );
    assert!(
        taste
            .prompt_block(None)
            .contains(r#"Never pick (the user turned these down): "Run (spotify:playlist:run)""#)
    );
    clock.advance(CORRECTION_MS as u64 + 1).await;
    assert_eq!(taste.last_pick(), None);
}

#[test]
fn lasting_dislikes_come_from_the_music_avoid_memories() {
    let Setup {
        _dir, root, taste, ..
    } = setup();
    let memories = root.join("companion-memories");
    std::fs::write(
        memories.join("music-avoid-jazz.md"),
        "---\nname: no jazz\ndescription: Jazz manouche\ntype: feedback\n---\nHe does not want it.\n",
    )
    .unwrap();
    std::fs::write(
        memories.join("other.md"),
        "---\nname: x\ndescription: Not music\ntype: user\n---\n",
    )
    .unwrap();
    assert_eq!(memory_avoids(Some(&memories)), ["Jazz manouche"]);
    assert_eq!(taste.avoid_list(), ["Jazz manouche"]);
    assert!(
        taste
            .prompt_block(None)
            .contains(r#"Never pick (the user turned these down): "Jazz manouche""#)
    );
}

#[test]
fn an_unreadable_file_starts_empty() {
    let Setup {
        _dir, root, taste, ..
    } = setup();
    std::fs::write(root.join("taste.json"), "{nope").unwrap();
    assert_eq!(taste.profile(), None);
    assert!(taste.due());
}
