//! YouTube as a source of a call's music, beside Spotify
//! (`voice/voice-youtube.ts`): yt-dlp finds the video (a search or a link)
//! and its audio stream where Roamgate runs, and the voice helper plays
//! that stream's sound into the call's mix as its music (its
//! `call_youtube` op). Spotify and YouTube never play together: the helper
//! pauses the Spotify app when the call's background carries its sound,
//! and the companion's tools stop the video when they start Spotify on
//! the call's music device. A helper from before call_youtube answers it
//! as an unknown op: YouTube then says it needs the new helper.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use regex::Regex;
use roamgate_base::clock::{Clock, SystemClock, timeout};
use serde_json::{Map, Value, json};

use crate::config::VoiceConfig;
use crate::helper::{EventSink, VoiceHelper};
use crate::js;

/// The MPRIS bus name prefix of the Spotify app, paused by YouTube.
pub const SPOTIFY_MPRIS: &str = "org.mpris.MediaPlayer2.spotify";
/// How long yt-dlp may take to find a video and its stream.
pub const RESOLVE_MS: u64 = 45_000;
/// How long the helper may take to answer (a start waits for sound).
pub const COMMAND_MS: u64 = 40_000;
/// What a helper without call_youtube makes of it.
pub const NEEDS_HELPER: &str =
    "YouTube needs the new voice helper: the one installed cannot play it";
/// YouTube with no call up.
pub const NO_CALL: &str = "YouTube plays only as a call's music, and no call is up";
/// A video with no Opus audio (only AAC in M4A, which the helper cannot read).
pub const NO_OPUS: &str =
    "this video has no Opus (WebM) audio, only formats the voice helper cannot play (AAC in M4A)";
const UPDATE_HINT: &str = "(YouTube may have changed: yt-dlp likely needs an update, `yt-dlp -U`)";

/// A video found: what plays, and the stream the helper reads.
#[derive(Debug, Clone, PartialEq)]
pub struct YoutubeTrack {
    pub title: String,
    /// Its YouTube page.
    pub url: String,
    pub channel: Option<String>,
    /// In seconds; none for a live stream.
    pub duration: Option<f64>,
    /// The audio stream's URL and the HTTP headers it is read with.
    pub stream: String,
    pub headers: Map<String, Value>,
}

/// A failure told as is: "the video could not be played: <reason>".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeError(pub String);

impl std::fmt::Display for YoutubeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for YoutubeError {}

fn error(message: impl Into<String>) -> YoutubeError {
    YoutubeError(message.into())
}

static YOUTUBE_HOSTS: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$|^youtu\.be$")
        .unwrap()
});

/// The host of an http(s) link, as `new URL(text).hostname` reads it
/// (lowercase, without port or credentials); None when it is not one.
fn link_host(text: &str) -> Option<String> {
    let rest = text.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(bracketed) = host_port.strip_prefix('[') {
        format!("[{}]", bracketed.split(']').next()?)
    } else {
        host_port.split(':').next()?.to_owned()
    };
    if host.is_empty() || host.contains(char::is_whitespace) {
        return None;
    }
    Some(host.to_lowercase())
}

/// yt-dlp's target for what was asked: a YouTube link as is, any other
/// words as a search taking the first video. A link elsewhere is refused.
pub fn youtube_target(asked: &str) -> Result<String, YoutubeError> {
    let text = js::trim(asked);
    if text.is_empty() {
        return Err(error("nothing was asked for"));
    }
    let lower = text.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let Some(host) = link_host(text) else {
            return Err(error(format!("{text} is not a link")));
        };
        if !YOUTUBE_HOSTS.is_match(&host) {
            return Err(error(format!("{host} is not YouTube")));
        }
        return Ok(text.to_owned());
    }
    Ok(format!("ytsearch1:{text}"))
}

/// yt-dlp's arguments: one video's JSON, its best audio-only stream in
/// WebM with Opus, the only one the voice helper reads.
pub fn yt_dlp_args(command: &[String], target: &str) -> Vec<String> {
    let mut args = command.to_vec();
    args.extend(
        [
            "--dump-json",
            "--no-playlist",
            "--no-warnings",
            "--format",
            "bestaudio[acodec=opus]/bestaudio[ext=webm]",
            "--",
            target,
        ]
        .map(String::from),
    );
    args
}

static ERROR_PREFIX: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^ERROR:\s*").unwrap());
static EXTRACTOR: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^\[[^\]]+\]\s*[\w-]+:\s*").unwrap());
static NOT_AVAILABLE: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"(?i)requested format is not available").unwrap());
static OUTDATED: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    Regex::new(r"(?i)\b403\b|forbidden|sign in to confirm|signature|nsig|po token|unable to extract|player response")
        .unwrap()
});

/// Why yt-dlp failed, from what it wrote, with what to do about it.
pub fn yt_dlp_failure(stderr: &str, code: Option<i32>) -> String {
    let line = stderr
        .split('\n')
        .map(js::trim)
        .rfind(|each| each.starts_with("ERROR:"))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            js::trim(js::trim(stderr).split('\n').next_back().unwrap_or("")).to_owned()
        });
    let stripped = ERROR_PREFIX.replace(&line, "");
    let stripped = EXTRACTOR.replace(&stripped, "");
    let mut reason = js::slice16(&stripped, 0, Some(300));
    if reason.is_empty() {
        reason = format!(
            "yt-dlp ended with {}",
            code.map_or("a signal".to_owned(), |c| c.to_string())
        );
    }
    if NOT_AVAILABLE.is_match(&reason) {
        return NO_OPUS.into();
    }
    if OUTDATED.is_match(&reason) {
        format!("{reason} {UPDATE_HINT}")
    } else {
        reason
    }
}

/// The track in yt-dlp's JSON output: its last JSON line.
pub fn parse_yt_dlp(stdout: &str) -> Result<YoutubeTrack, YoutubeError> {
    let Some(line) = stdout
        .split('\n')
        .map(js::trim)
        .rfind(|each| each.starts_with('{'))
    else {
        return Err(error("nothing was found on YouTube"));
    };
    let Ok(Value::Object(video)) = serde_json::from_str::<Value>(line) else {
        return Err(error("yt-dlp's answer could not be read"));
    };
    let stream = video.get("url").and_then(Value::as_str).unwrap_or("");
    if stream.is_empty() {
        return Err(error("the video has no audio stream"));
    }
    if video.get("acodec") != Some(&json!("opus")) && video.get("ext") != Some(&json!("webm")) {
        return Err(error(NO_OPUS));
    }
    let mut headers = Map::new();
    if let Some(Value::Object(given)) = video.get("http_headers") {
        for (key, value) in given {
            if value.is_string() {
                headers.insert(key.clone(), value.clone());
            }
        }
    }
    let text = |key: &str| {
        video
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    let or = |a: String, b: String| if a.is_empty() { b } else { a };
    let channel = or(text("channel"), text("uploader"));
    Ok(YoutubeTrack {
        title: or(text("title"), "an untitled video".into()),
        url: or(text("webpage_url"), text("original_url")),
        channel: (!channel.is_empty()).then_some(channel),
        duration: video
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| *d > 0.0)
            .map(js::round),
        stream: stream.to_owned(),
        headers,
    })
}

/// What a command run gave: its exit code (None: a signal) and output.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ran {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// What runs yt-dlp: its arguments (program first) and how long it may
/// take; an error when it could not be run.
pub type RunCommand =
    Arc<dyn Fn(Vec<String>, u64) -> BoxFuture<'static, Result<Ran, String>> + Send + Sync>;

/// Runs a local program, killed past `timeout_ms`.
pub fn run_command() -> RunCommand {
    Arc::new(|args: Vec<String>, timeout_ms: u64| {
        Box::pin(async move {
            let (program, rest) = args.split_first().ok_or("no program")?;
            let child = tokio::process::Command::new(program)
                .args(rest)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| e.to_string())?;
            match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output())
                .await
            {
                Ok(Ok(output)) => Ok(Ran {
                    code: output.status.code(),
                    stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
                    stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
                }),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Ok(Ran {
                    code: None,
                    stdout: String::new(),
                    stderr: format!(
                        "ERROR: no answer within {} s",
                        js::number_text(timeout_ms as f64 / 1000.0)
                    ),
                }),
            }
        })
    })
}

/// Finds `asked` (words or a YouTube link) with yt-dlp.
pub async fn resolve_youtube(
    asked: &str,
    command: &[String],
    run: &RunCommand,
) -> Result<YoutubeTrack, YoutubeError> {
    let target = youtube_target(asked)?;
    let done = run(yt_dlp_args(command, &target), RESOLVE_MS)
        .await
        .map_err(|message| {
            error(format!(
                "{} could not be run ({message}): install yt-dlp, or set voice.json's yt_dlp",
                command.first().map_or("", String::as_str)
            ))
        })?;
    if done.code != Some(0) {
        return Err(error(yt_dlp_failure(&done.stderr, done.code)));
    }
    parse_yt_dlp(&done.stdout)
}

/// The voice helper as YouTube uses it: call_youtube on the call running,
/// and its events.
pub trait YoutubeHelper: Send + Sync {
    /// Whether a call runs: YouTube plays only in one.
    fn in_call(&self) -> bool;
    /// A call_youtube request to the call running, its music put on first
    /// with `music_on`: the helper's answer, or its error.
    fn call_youtube(
        &self,
        command: Map<String, Value>,
        music_on: bool,
    ) -> BoxFuture<'_, Result<Map<String, Value>, String>>;
    /// Listens to the helper's call_youtube events.
    fn on_youtube(&self, listener: EventSink);
}

impl YoutubeHelper for VoiceHelper {
    fn in_call(&self) -> bool {
        VoiceHelper::in_call(self)
    }

    fn call_youtube(
        &self,
        command: Map<String, Value>,
        music_on: bool,
    ) -> BoxFuture<'_, Result<Map<String, Value>, String>> {
        Box::pin(VoiceHelper::call_youtube(self, command, music_on))
    }

    fn on_youtube(&self, listener: EventSink) {
        VoiceHelper::on_youtube(self, listener);
    }
}

/// Why the helper failed, as the tools tell it.
pub fn helper_failure(message: &str) -> String {
    if message.contains("unknown op call_youtube") {
        return NEEDS_HELPER.into();
    }
    if message == "no call"
        || message.starts_with("no call")
            && !message[7..].starts_with(|c: char| c.is_alphanumeric() || c == '_')
    {
        return NO_CALL.into();
    }
    message.to_owned()
}

/// What YouTube plays, as the companion's tools tell it.
#[derive(Debug, Clone, PartialEq)]
pub struct YoutubeStatus {
    /// playing, paused or stopped.
    pub state: String,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// 0 to 100.
    pub volume: f64,
    /// title, url and channel.
    pub track: Option<(String, String, Option<String>)>,
    /// Why it stopped by itself: the video ended, Spotify started, ...
    pub ended: Option<String>,
    /// Whether starting or resuming it paused the Spotify app.
    pub spotify_paused: bool,
    /// The call's music was put off since: the video is not heard.
    pub music_off: bool,
}

impl YoutubeStatus {
    /// As the tools give it (the TS object, its keys in order).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("state".into(), json!(self.state));
        if let Some(position) = self.position {
            out.insert("position".into(), js::number(position));
        }
        if let Some(duration) = self.duration {
            out.insert("duration".into(), js::number(duration));
        }
        out.insert("volume".into(), js::number(self.volume));
        if let Some((title, url, channel)) = &self.track {
            let mut track = Map::new();
            track.insert("title".into(), json!(title));
            track.insert("url".into(), json!(url));
            if let Some(channel) = channel {
                track.insert("channel".into(), json!(channel));
            }
            out.insert("track".into(), Value::Object(track));
        }
        if let Some(ended) = &self.ended {
            out.insert("ended".into(), json!(ended));
        }
        if self.spotify_paused {
            out.insert("spotifyPaused".into(), json!(true));
        }
        if self.music_off {
            out.insert("musicOff".into(), json!(true));
        }
        Value::Object(out)
    }
}

#[derive(Default)]
struct PlayerState {
    track: Option<YoutubeTrack>,
    ended: Option<String>,
    paused_spotify: bool,
}

/// Finds what was asked for.
pub type Resolve =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<YoutubeTrack, YoutubeError>> + Send + Sync>;

/// The YouTube player of the companion's tools, driving the helper's
/// call_youtube; each command waits for its answer.
pub struct YoutubePlayer {
    helper: Arc<dyn YoutubeHelper>,
    resolve: Resolve,
    timeout_ms: u64,
    mpris: String,
    clock: Arc<dyn Clock>,
    state: Arc<Mutex<PlayerState>>,
    /// 0 to 1, kept for the next video.
    level: Mutex<f64>,
}

impl YoutubePlayer {
    pub fn new(helper: Arc<dyn YoutubeHelper>, resolve: Resolve) -> Self {
        Self::with(helper, resolve, COMMAND_MS, Arc::new(SystemClock))
    }

    pub fn with(
        helper: Arc<dyn YoutubeHelper>,
        resolve: Resolve,
        timeout_ms: u64,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let state: Arc<Mutex<PlayerState>> = Arc::default();
        let events = state.clone();
        helper.on_youtube(Arc::new(move |event| youtube_event(&events, &event)));
        Self {
            helper,
            resolve,
            timeout_ms,
            mpris: SPOTIFY_MPRIS.into(),
            clock,
            state,
            level: Mutex::new(1.0),
        }
    }

    fn level(&self) -> f64 {
        *self.level.lock().unwrap()
    }

    /// Finds `asked` and plays it in the call, its music put on, pausing
    /// Spotify when it plays here; what plays.
    pub async fn play(&self, asked: &str) -> Result<YoutubeStatus, YoutubeError> {
        // A helper that cannot, or no call, is told before yt-dlp runs.
        self.send(json!({"action": "status"}), false).await?;
        let track = (self.resolve)(asked.to_owned()).await?;
        let reply = self
            .send(
                json!({
                    "action": "play",
                    "url": track.stream,
                    "headers": track.headers,
                    "volume": js::number(self.level()),
                    "pause_mpris": self.mpris,
                }),
                true,
            )
            .await?;
        {
            let mut state = self.state.lock().unwrap();
            state.track = Some(track);
            state.ended = None;
            state.paused_spotify = reply.get("spotify_paused") == Some(&json!(true));
        }
        Ok(self.status(&reply))
    }

    pub async fn pause(&self) -> Result<YoutubeStatus, YoutubeError> {
        let reply = self.send(json!({"action": "pause"}), false).await?;
        Ok(self.status(&reply))
    }

    /// Plays again what was paused, pausing Spotify when it plays here.
    pub async fn resume(&self) -> Result<YoutubeStatus, YoutubeError> {
        let reply = self
            .send(json!({"action": "resume", "pause_mpris": self.mpris}), true)
            .await?;
        self.state.lock().unwrap().paused_spotify =
            reply.get("spotify_paused") == Some(&json!(true));
        Ok(self.status(&reply))
    }

    /// Stops the video; nothing to do without a call.
    pub async fn stop(&self) -> Result<YoutubeStatus, YoutubeError> {
        if !self.helper.in_call() {
            return Ok(self.gone());
        }
        let reply = self.send(json!({"action": "stop"}), false).await?;
        self.state.lock().unwrap().track = None;
        Ok(self.status(&reply))
    }

    /// The video's own volume, 0 to 100 (the call sets the music's level).
    pub async fn volume(&self, percent: f64) -> Result<YoutubeStatus, YoutubeError> {
        let level = percent.clamp(0.0, 100.0) / 100.0;
        *self.level.lock().unwrap() = level;
        if !self.helper.in_call() {
            return Ok(self.gone());
        }
        let reply = self
            .send(
                json!({"action": "volume", "volume": js::number(level)}),
                false,
            )
            .await?;
        Ok(self.status(&reply))
    }

    /// Goes to `position` seconds, or `by` seconds from where it is.
    pub async fn seek(
        &self,
        position: Option<f64>,
        by: Option<f64>,
    ) -> Result<YoutubeStatus, YoutubeError> {
        let position = match position {
            Some(position) => position,
            None => {
                let now = self.send(json!({"action": "status"}), false).await?;
                now.get("position").and_then(Value::as_f64).unwrap_or(0.0) + by.unwrap_or(0.0)
            }
        };
        let reply = self
            .send(
                json!({"action": "seek", "position": js::number(position.max(0.0))}),
                false,
            )
            .await?;
        Ok(self.status(&reply))
    }

    /// What plays now.
    pub async fn now_playing(&self) -> Result<YoutubeStatus, YoutubeError> {
        if !self.helper.in_call() {
            return Ok(self.gone());
        }
        let reply = self.send(json!({"action": "status"}), false).await?;
        Ok(self.status(&reply))
    }

    /// Spotify started: YouTube stops, so they never play together.
    pub async fn spotify_started(&self) {
        if self.state.lock().unwrap().track.is_none() || !self.helper.in_call() {
            return;
        }
        let _ = self.stop().await;
        self.state.lock().unwrap().ended = Some("Spotify started playing".into());
    }

    /// No call: whatever played ended with it.
    fn gone(&self) -> YoutubeStatus {
        {
            let mut state = self.state.lock().unwrap();
            if state.track.take().is_some() {
                state.ended = Some("the call ended".into());
            }
        }
        self.status(&Map::new())
    }

    fn status(&self, reply: &Map<String, Value>) -> YoutubeStatus {
        let state_name = reply
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("stopped")
            .to_owned();
        let stopped = state_name == "stopped";
        let mut state = self.state.lock().unwrap();
        // The helper lost it (its call was made again after a restart).
        if stopped && state.track.take().is_some() && state.ended.is_none() {
            state.ended = Some("the call's audio restarted".into());
        }
        let track = state.track.as_ref().filter(|_| !stopped);
        YoutubeStatus {
            position: reply.get("position").and_then(Value::as_f64),
            duration: reply
                .get("duration")
                .and_then(Value::as_f64)
                .or_else(|| track.and_then(|t| t.duration).filter(|d| *d != 0.0)),
            volume: js::round(self.level() * 100.0),
            track: track.map(|t| {
                (
                    t.title.clone(),
                    t.url.clone(),
                    t.channel.clone().filter(|c| !c.is_empty()),
                )
            }),
            ended: if stopped { state.ended.clone() } else { None },
            spotify_paused: state.paused_spotify && state_name == "playing",
            music_off: reply.get("music_muted") == Some(&json!(true)) && !stopped,
            state: state_name,
        }
    }

    /// A call_youtube request; `music_on`: the call's music put on first.
    async fn send(
        &self,
        command: Value,
        music_on: bool,
    ) -> Result<Map<String, Value>, YoutubeError> {
        let Value::Object(command) = command else {
            unreachable!("commands are objects")
        };
        let asked = self.helper.call_youtube(command, music_on);
        match timeout(&*self.clock, Duration::from_millis(self.timeout_ms), asked).await {
            Ok(Ok(reply)) => Ok(reply),
            Ok(Err(message)) => Err(error(helper_failure(&message))),
            Err(_) => Err(error(helper_failure("the voice helper did not answer"))),
        }
    }
}

/// The helper's call_youtube events: a video stopping by itself.
fn youtube_event(state: &Mutex<PlayerState>, event: &Map<String, Value>) {
    if event.get("state") != Some(&json!("stopped")) {
        return;
    }
    let ended = match event.get("why").and_then(Value::as_str) {
        Some("ended") => "the video ended".to_owned(),
        Some("spotify") => "Spotify started playing".to_owned(),
        _ => event
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("it stopped")
            .to_owned(),
    };
    let mut state = state.lock().unwrap();
    state.ended = Some(ended);
    state.track = None;
}

/// voice.json's YouTube: the yt-dlp command; None when it is off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YoutubeConfig {
    pub yt_dlp: Vec<String>,
}

/// Whether the companion has YouTube for a call's music, and how: with
/// call_background set, unless `youtube` is false. The keys of the player
/// YouTube had before the helper played it are ignored.
pub fn youtube_config(config: &VoiceConfig) -> Option<YoutubeConfig> {
    if config.get("youtube") == Some(&json!(false))
        || config
            .str("call_background")
            .map(js::trim)
            .unwrap_or("")
            .is_empty()
    {
        return None;
    }
    let yt_dlp = config.strings("yt_dlp").filter(|list| !list.is_empty());
    Some(YoutubeConfig {
        yt_dlp: yt_dlp.unwrap_or_else(|| vec!["yt-dlp".into()]),
    })
}

#[cfg(test)]
mod tests;
