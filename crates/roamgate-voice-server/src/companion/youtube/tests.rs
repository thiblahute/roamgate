use std::sync::{Arc, Mutex};

use futures_util::FutureExt;
use roamgate_base::clock::TokioClock;
use serde_json::{Map, Value, json};

use crate::config::{VoiceConfig, read_voice_config};

use super::*;

fn track() -> YoutubeTrack {
    YoutubeTrack {
        title: "Around the World".into(),
        url: "https://www.youtube.com/watch?v=K0HSD_i2DvA".into(),
        channel: Some("Daft Punk".into()),
        duration: Some(242.0),
        stream: "https://rr3.googlevideo.com/videoplayback?x=1".into(),
        headers: json!({"User-Agent": "UA", "Accept": "*/*"})
            .as_object()
            .unwrap()
            .clone(),
    }
}

#[test]
fn words_search_a_youtube_link_plays_as_is_another_site_is_refused() {
    assert_eq!(
        youtube_target(" daft punk ").unwrap(),
        "ytsearch1:daft punk"
    );
    assert_eq!(
        youtube_target("https://youtu.be/K0HSD_i2DvA").unwrap(),
        "https://youtu.be/K0HSD_i2DvA"
    );
    assert_eq!(
        youtube_target("https://music.youtube.com/watch?v=x").unwrap(),
        "https://music.youtube.com/watch?v=x"
    );
    assert_eq!(
        youtube_target("https://evil.example/watch?v=x")
            .unwrap_err()
            .0,
        "evil.example is not YouTube"
    );
    assert!(youtube_target("  ").is_err());
}

#[test]
fn yt_dlp_gets_the_target_after_never_as_an_option() {
    let args = yt_dlp_args(&["yt-dlp".into()], "ytsearch1:--exec rm");
    assert_eq!(args[args.len() - 2], "--");
    assert_eq!(args[args.len() - 1], "ytsearch1:--exec rm");
    assert!(args.contains(&"--no-playlist".to_owned()));
    // Only WebM with Opus: the helper has no AAC decoder.
    let format = args.iter().position(|a| a == "--format").unwrap();
    assert_eq!(
        args[format + 1],
        "bestaudio[acodec=opus]/bestaudio[ext=webm]"
    );
}

#[test]
fn its_json_gives_the_title_page_length_stream_and_headers() {
    let t = track();
    let line = json!({
        "title": t.title,
        "webpage_url": t.url,
        "channel": t.channel,
        "duration": 241.6,
        "url": t.stream,
        "ext": "webm",
        "acodec": "opus",
        "http_headers": t.headers,
    })
    .to_string();
    assert_eq!(parse_yt_dlp(&format!("[info] noise\n{line}\n")).unwrap(), t);
    assert_eq!(
        parse_yt_dlp("").unwrap_err().0,
        "nothing was found on YouTube"
    );
    assert!(
        parse_yt_dlp(r#"{"title":"x"}"#)
            .unwrap_err()
            .0
            .contains("no audio stream")
    );
}

#[test]
fn a_video_with_only_aac_audio_says_the_helper_cannot_play_it() {
    let m4a = json!({"title": "x", "url": track().stream, "ext": "m4a", "acodec": "mp4a.40.2"})
        .to_string();
    assert_eq!(parse_yt_dlp(&m4a).unwrap_err().0, NO_OPUS);
    assert_eq!(
        yt_dlp_failure(
            "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats",
            Some(1)
        ),
        NO_OPUS
    );
}

#[test]
fn a_failure_says_why_and_an_outdated_yt_dlp_says_to_update_it() {
    assert_eq!(
        yt_dlp_failure(
            "WARNING: x\nERROR: [youtube] K0HSD_i2DvA: Video unavailable\n",
            Some(1)
        ),
        "Video unavailable"
    );
    assert!(
        yt_dlp_failure(
            "ERROR: unable to download video data: HTTP Error 403: Forbidden",
            Some(1)
        )
        .contains("yt-dlp -U")
    );
    assert_eq!(yt_dlp_failure("", Some(2)), "yt-dlp ended with 2");
}

#[tokio::test]
async fn resolving_runs_the_configured_yt_dlp_and_tells_its_failure() {
    let ran: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let kept = ran.clone();
    let run: RunCommand = Arc::new(move |args, _| {
        kept.lock().unwrap().push(args);
        async {
            Ok(Ran {
                code: Some(1),
                stdout: String::new(),
                stderr: "ERROR: [youtube] x: Sign in to confirm you're not a bot".into(),
            })
        }
        .boxed()
    });
    let failed = resolve_youtube("miles davis", &["host-spawn".into(), "yt-dlp".into()], &run)
        .await
        .unwrap_err()
        .0;
    assert!(
        regex::Regex::new("Sign in to confirm.*yt-dlp -U")
            .unwrap()
            .is_match(&failed)
    );
    let first = ran.lock().unwrap()[0].clone();
    assert_eq!(first[..2], ["host-spawn", "yt-dlp"]);
    assert_eq!(first.last().unwrap(), "ytsearch1:miles davis");
    let missing: RunCommand = Arc::new(|_, _| async { Err("ENOENT".to_owned()) }.boxed());
    assert!(
        resolve_youtube("x", &["missing-yt-dlp".into()], &missing)
            .await
            .unwrap_err()
            .0
            .contains("missing-yt-dlp could not be run (ENOENT)")
    );
}

type Answer = Arc<dyn Fn(&Map<String, Value>) -> Result<Map<String, Value>, String> + Send + Sync>;

/// A voice helper the test answers, as the helper's call_youtube would.
#[derive(Default)]
struct FakeHelper {
    call: Mutex<bool>,
    sent: Mutex<Vec<Map<String, Value>>>,
    /// The requests that put the call's music on first.
    music_on: Mutex<Vec<String>>,
    listeners: Mutex<Vec<crate::helper::EventSink>>,
    answer: Option<Answer>,
    hangs: bool,
}

impl FakeHelper {
    fn new(answer: Option<Answer>) -> Arc<Self> {
        Arc::new(Self {
            call: Mutex::new(true),
            answer,
            ..Self::default()
        })
    }

    fn set_call(&self, call: bool) {
        *self.call.lock().unwrap() = call;
    }

    fn actions(&self) -> Vec<String> {
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|c| c["action"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The helper tells a call_youtube event.
    fn tell(&self, event: Value) {
        let mut full = json!({"event": "call_youtube", "call": 1});
        full.as_object_mut()
            .unwrap()
            .extend(event.as_object().unwrap().clone());
        for listener in self.listeners.lock().unwrap().iter() {
            listener(full.as_object().unwrap().clone());
        }
    }
}

impl YoutubeHelper for FakeHelper {
    fn in_call(&self) -> bool {
        *self.call.lock().unwrap()
    }

    fn call_youtube(
        &self,
        command: Map<String, Value>,
        music_on: bool,
    ) -> BoxFuture<'_, Result<Map<String, Value>, String>> {
        if self.hangs {
            return std::future::pending().boxed();
        }
        if !self.in_call() {
            return async { Err("no call".to_owned()) }.boxed();
        }
        self.sent.lock().unwrap().push(command.clone());
        let action = command["action"].as_str().unwrap_or("").to_owned();
        if music_on {
            self.music_on.lock().unwrap().push(action.clone());
        }
        let reply = match &self.answer {
            Some(answer) => answer(&command),
            None => {
                let mut reply = json!({
                    "state": match action.as_str() {
                        "pause" => "paused",
                        "stop" => "stopped",
                        _ => "playing",
                    },
                    "position": 12,
                    "duration": 242,
                    "volume": command.get("volume").filter(|v| v.is_number()).cloned().unwrap_or(json!(1)),
                    "music_muted": false,
                });
                if action == "play" || action == "resume" {
                    reply["spotify_paused"] = json!(false);
                }
                Ok(reply.as_object().unwrap().clone())
            }
        };
        async move { reply }.boxed()
    }

    fn on_youtube(&self, listener: crate::helper::EventSink) {
        self.listeners.lock().unwrap().push(listener);
    }
}

fn answer(
    f: impl Fn(&Map<String, Value>) -> Result<Value, String> + Send + Sync + 'static,
) -> Option<Answer> {
    Some(Arc::new(move |c| {
        f(c).map(|v| v.as_object().unwrap().clone())
    }))
}

struct Player {
    using: YoutubePlayer,
    helper: Arc<FakeHelper>,
    asked: Arc<Mutex<Vec<String>>>,
}

fn player(answer: Option<Answer>) -> Player {
    let helper = FakeHelper::new(answer);
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = asked.clone();
    let using = YoutubePlayer::with(
        helper.clone(),
        Arc::new(move |what| {
            kept.lock().unwrap().push(what);
            async { Ok(track()) }.boxed()
        }),
        1000,
        Arc::new(TokioClock::starting_at(0)),
    );
    Player {
        using,
        helper,
        asked,
    }
}

#[tokio::test]
async fn play_gives_the_helper_the_stream_and_headers_the_music_put_on() {
    let Player {
        using,
        helper,
        asked,
    } = player(None);
    let status = using.play("around the world").await.unwrap();
    assert_eq!(*asked.lock().unwrap(), vec!["around the world"]);
    let t = track();
    assert_eq!(
        Value::Array(
            helper
                .sent
                .lock()
                .unwrap()
                .iter()
                .cloned()
                .map(Value::Object)
                .collect()
        ),
        json!([
            {"action": "status"},
            {"action": "play", "url": t.stream, "headers": t.headers, "volume": 1, "pause_mpris": SPOTIFY_MPRIS},
        ])
    );
    assert_eq!(*helper.music_on.lock().unwrap(), vec!["play"]);
    assert_eq!(
        status.to_json(),
        json!({
            "state": "playing",
            "position": 12,
            "duration": 242,
            "volume": 100,
            "track": {"title": t.title, "url": t.url, "channel": t.channel},
        })
    );
}

#[tokio::test]
async fn pause_resume_volume_seek_and_status_go_to_the_call() {
    let Player { using, helper, .. } = player(None);
    using.play("x").await.unwrap();
    assert_eq!(using.pause().await.unwrap().state, "paused");
    assert_eq!(using.resume().await.unwrap().state, "playing");
    assert_eq!(using.volume(40.0).await.unwrap().volume, 40.0);
    using.seek(None, Some(30.0)).await.unwrap();
    using.seek(Some(5.0), None).await.unwrap();
    assert_eq!(
        using.now_playing().await.unwrap().track.unwrap().0,
        track().title
    );
    assert_eq!(
        helper.actions(),
        [
            "status", "play", "pause", "resume", "volume", "status", "seek", "seek", "status"
        ]
    );
    let sent = helper.sent.lock().unwrap().clone();
    assert_eq!(
        Value::Object(sent[3].clone()),
        json!({"action": "resume", "pause_mpris": SPOTIFY_MPRIS})
    );
    assert_eq!(*helper.music_on.lock().unwrap(), vec!["play", "resume"]);
    assert_eq!(sent[4]["volume"], json!(0.4));
    // 12 s in, 30 s ahead.
    assert_eq!(sent[6]["position"], json!(42));
    assert_eq!(sent[7]["position"], json!(5));
    // The next video keeps the volume.
    using.play("y").await.unwrap();
    assert_eq!(
        helper.sent.lock().unwrap().last().unwrap()["volume"],
        json!(0.4)
    );
}

#[tokio::test]
async fn an_older_helper_or_no_call_is_told_before_yt_dlp_runs() {
    let Player {
        using,
        helper,
        asked,
    } = player(answer(|_| Err("unknown op call_youtube".into())));
    assert_eq!(using.play("x").await.unwrap_err().0, NEEDS_HELPER);
    assert!(asked.lock().unwrap().is_empty());
    helper.set_call(false);
    assert_eq!(using.play("x").await.unwrap_err().0, NO_CALL);
    assert!(asked.lock().unwrap().is_empty());
    assert_eq!(helper_failure("no call 3"), NO_CALL);
    assert_eq!(
        helper_failure("Resource 'the stream' not found"),
        "Resource 'the stream' not found"
    );
}

#[tokio::test]
async fn without_a_call_nothing_plays_and_what_played_ended_with_it() {
    let Player { using, helper, .. } = player(None);
    helper.set_call(false);
    assert_eq!(
        using.now_playing().await.unwrap().to_json(),
        json!({"state": "stopped", "volume": 100})
    );
    assert_eq!(using.stop().await.unwrap().state, "stopped");
    assert_eq!(using.pause().await.unwrap_err().0, NO_CALL);
    helper.set_call(true);
    using.play("x").await.unwrap();
    helper.set_call(false);
    assert_eq!(
        using.now_playing().await.unwrap().to_json(),
        json!({"state": "stopped", "volume": 100, "ended": "the call ended"})
    );
}

#[tokio::test]
async fn a_failed_start_is_told_with_the_helpers_reason() {
    let Player { using, .. } = player(answer(|command| {
        if command["action"] == "play" {
            return Err("Request for 'the stream' failed: 403 Forbidden".into());
        }
        Ok(json!({"state": "stopped"}))
    }));
    assert_eq!(
        using.play("x").await.unwrap_err(),
        YoutubeError("Request for 'the stream' failed: 403 Forbidden".into())
    );
}

#[tokio::test]
async fn spotify_paused_for_it_its_end_and_spotifys_start_are_told() {
    let Player { using, helper, .. } = player(answer(|command| {
        Ok(json!({
            "state": if command["action"] == "status" { "stopped" } else { "playing" },
            "spotify_paused": command["action"] == "play",
        }))
    }));
    assert!(using.play("x").await.unwrap().spotify_paused);
    helper.tell(json!({"state": "playing", "position": 0, "duration": 242}));
    helper.tell(json!({"state": "stopped", "why": "ended", "reason": "the video ended"}));
    assert_eq!(
        using.now_playing().await.unwrap().to_json(),
        json!({"state": "stopped", "volume": 100, "ended": "the video ended"})
    );
    using.play("x").await.unwrap();
    helper.tell(json!({"state": "stopped", "why": "spotify", "reason": "Spotify started playing"}));
    assert_eq!(
        using.now_playing().await.unwrap().ended.as_deref(),
        Some("Spotify started playing")
    );
    using.play("x").await.unwrap();
    helper.tell(json!({"state": "stopped", "why": "error", "reason": "it failed: x"}));
    assert_eq!(
        using.now_playing().await.unwrap().ended.as_deref(),
        Some("it failed: x")
    );
    // Lost without a word (the helper restarted): said so.
    using.play("x").await.unwrap();
    assert_eq!(
        using.now_playing().await.unwrap().ended.as_deref(),
        Some("the call's audio restarted")
    );
}

#[tokio::test]
async fn spotify_starting_on_the_calls_device_stops_youtube() {
    let Player { using, helper, .. } = player(answer(|command| {
        Ok(json!({"state": if command["action"] == "stop" { "stopped" } else { "playing" }}))
    }));
    using.play("x").await.unwrap();
    using.spotify_started().await;
    assert_eq!(helper.actions().last().unwrap(), "stop");
    // Nothing to stop: nothing is asked for it.
    let sent = helper.actions().len();
    using.spotify_started().await;
    assert_eq!(helper.actions().len(), sent);
}

#[tokio::test(start_paused = true)]
async fn a_helper_that_does_not_answer_fails_the_command() {
    let helper = Arc::new(FakeHelper {
        call: Mutex::new(true),
        hangs: true,
        ..FakeHelper::default()
    });
    let using = YoutubePlayer::with(
        helper,
        Arc::new(|_| async { Ok(track()) }.boxed()),
        20,
        Arc::new(TokioClock::starting_at(0)),
    );
    assert_eq!(
        using.pause().await.unwrap_err().0,
        "the voice helper did not answer"
    );
}

fn config(value: Value) -> VoiceConfig {
    VoiceConfig {
        raw: value.as_object().unwrap().clone(),
    }
}

#[test]
fn on_with_call_background_unless_youtube_is_false() {
    assert_eq!(youtube_config(&config(json!({"helper": "h"}))), None);
    assert_eq!(
        youtube_config(&config(
            json!({"helper": "h", "call_background": "x", "youtube": false})
        )),
        None
    );
    assert_eq!(
        youtube_config(&config(json!({"helper": "h", "call_background": "x"}))),
        Some(YoutubeConfig {
            yt_dlp: vec!["yt-dlp".into()]
        })
    );
    assert_eq!(
        youtube_config(&config(
            json!({"helper": "h", "call_background": "x", "yt_dlp": ["/opt/yt-dlp"]})
        )),
        Some(YoutubeConfig {
            yt_dlp: vec!["/opt/yt-dlp".into()]
        })
    );
}

#[test]
fn its_keys_are_checked_the_old_players_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let read = |extra: Value| {
        let path = dir.path().join("voice.json");
        let mut body = json!({"helper": crate::testdata::a_file(), "whisper_model": crate::testdata::a_file(), "tts_models": [{"model": "kokoro"}]});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        std::fs::write(&path, body.to_string()).unwrap();
        read_voice_config(&path)
    };
    assert!(
        read(json!({"youtube": "yes"}))
            .unwrap_err()
            .contains("youtube must be")
    );
    assert!(
        read(json!({"yt_dlp": []}))
            .unwrap_err()
            .contains("yt_dlp must be")
    );
    let old = read(json!({
        "call_background": "x",
        "youtube_sink": 3,
        "youtube_player_wrapper": "systemd-run",
        "yt_dlp": ["yt-dlp"],
    }))
    .unwrap();
    assert_eq!(
        youtube_config(&old),
        Some(YoutubeConfig {
            yt_dlp: vec!["yt-dlp".into()]
        })
    );
}
