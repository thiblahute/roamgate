//! The companion's routes of http/voice.ts (createVoiceRoutes' own, the
//! rest being [`super::routes`]):
//!
//! - POST /api/voice/route: `{current, said, sessions, ...}` in, who it
//!   was said to out: the front decides (`front_model`, with `reply`, what
//!   to say at once), else the router (voice-router.ts). With `stream` the
//!   answer is NDJSON: `{"early": {to, reply}}` first, then the route. A
//!   page lists the routes it knows (`routes`): one it does not gets the
//!   nearest older one ([`legacy_route`]).
//! - POST /api/voice/event: what the front tells of an event, an agent's
//!   answer (a long one as its start and the file where it is whole) or
//!   what one wrote while it works.
//! - POST /api/voice/forward and GET /api/voice/errand: the companion's
//!   work on a session, followed by a job.
//! - /api/voice/research and /api/voice/tools: the front's web searches
//!   and tool jobs, listed, cancelled, and a held call answered by a click.
//! - /api/voice/answers: the jobs' answers nobody heard yet.
//! - /api/voice/companion/memories and /reset: its memory files, and
//!   forgetting everything.
//! - GET /api/voice/image: an image of the companion's conversation.
//!
//! What a search or a tool found is only shown and said: nothing here
//! routes, forwards or sends because of it.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use regex::Regex;
use roamgate_base::clock::{Clock, SystemClock};
use roamgate_base::log::{LogFields, Logger};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use super::routes::{CompanionStatus, CurrentCall, call_music, music_route};
use super::{Answer, AnswerBody, Request, StreamBody, decode_uri_component, needs_header};
use crate::companion::answers::{MAX_ANSWER_CHARS, answer_for_front, default_answers_dir};
use crate::companion::errands::{ErrandAbout, ErrandState, VoiceErrands};
use crate::companion::front::{
    CallFacts, EarlyReply, FrontEvent, FrontEventRequest, FrontReply, FrontTiming, FrontTurn,
    VoiceFront, call_lines, forwarded_words, recovered_words, skipped_context, skipped_words,
    voice_naming,
};
use crate::companion::images::{VOICE_IMAGE_HEADERS, upload_root, uploaded_images, voice_image};
use crate::companion::memory::{CompanionMemory, MemoryKind, Note};
use crate::companion::memory_files::CompanionMemoryFiles;
use crate::companion::research::{VoiceResearch, research_context};
use crate::companion::router::{RouteRequest, VoiceRoute, VoiceRouter, VoiceSessionInfo};
use crate::companion::tools::{VoiceTools, tools_context};
use crate::companion::turn_causes::{TurnCauses, with_turn_context};
use crate::companion::waiting::WaitingAnswers;
use crate::helper::{ErrorSink, VoiceHelper};
use crate::js;
use crate::speakers::{SpeakerTracker, VoiceTag, VoiceVerdict, parse_voice_tag};

/// The state a page gives the front beyond the sessions.
const MAX_CONTEXT_CHARS: i64 = 12000;
/// An event's words, and what an agent wrote while it works. An agent's
/// answer is taken whole (up to MAX_ANSWER_CHARS).
const MAX_EVENT_CHARS: i64 = 1000;
const MAX_PROGRESS_CHARS: i64 = 12000;
/// What the page gives of the call lately, for the front.
const MAX_RECENT_CHARS: i64 = 4000;
/// A typed turn with images: the model looks at them before it answers.
const FRONT_IMAGE_TIMEOUT_MS: u64 = 45_000;

/// The routes every page knows, from before the front.
const LEGACY_ROUTES: [&str; 7] = [
    "current", "nobody", "open", "send", "ranger", "errand", "ask",
];

/// The front as the routes use it ([`VoiceFront`]; tests give a fake).
pub trait Front: Send + Sync {
    fn warm(&self);
    fn restart(&self);
    fn turn(&self, request: FrontTurn) -> BoxFuture<'static, FrontReply>;
    fn event(&self, request: FrontEventRequest) -> BoxFuture<'static, String>;
}

impl Front for VoiceFront {
    fn warm(&self) {
        VoiceFront::warm(self);
    }

    fn restart(&self) {
        VoiceFront::restart(self);
    }

    fn turn(&self, request: FrontTurn) -> BoxFuture<'static, FrontReply> {
        let front = self.clone();
        async move { front.turn(request).await }.boxed()
    }

    fn event(&self, request: FrontEventRequest) -> BoxFuture<'static, String> {
        let front = self.clone();
        async move { front.event(request).await }.boxed()
    }
}

/// The router without a front ([`VoiceRouter`]).
pub trait Router: Send + Sync {
    fn warm(&self);
    fn route(&self, request: RouteRequest) -> BoxFuture<'static, VoiceRoute>;
}

impl Router for VoiceRouter {
    fn warm(&self) {
        VoiceRouter::warm(self);
    }

    fn route(&self, request: RouteRequest) -> BoxFuture<'static, VoiceRoute> {
        let router = self.clone();
        async move { router.route(request).await }.boxed()
    }
}

/// What the companion remembers across calls ([`CompanionMemory`]).
pub trait Memory: Send + Sync {
    fn epoch(&self) -> i64;
    fn record(&self, note: Note);
    fn reset(&self) -> i64;
    fn forget(&self, what: &str);
}

impl Memory for CompanionMemory {
    fn epoch(&self) -> i64 {
        CompanionMemory::epoch(self)
    }

    fn record(&self, note: Note) {
        CompanionMemory::record(self, note);
    }

    fn reset(&self) -> i64 {
        CompanionMemory::reset(self)
    }

    fn forget(&self, what: &str) {
        CompanionMemory::forget(self, what);
    }
}

/// Work said by voice on sessions ([`VoiceErrands`]).
pub trait Errands: Send + Sync {
    fn start(
        &self,
        pane: &str,
        text: &str,
        about: ErrandAbout,
    ) -> BoxFuture<'static, Result<String, String>>;
    fn state(&self, id: &str) -> Option<ErrandState>;
}

impl Errands for VoiceErrands {
    fn start(
        &self,
        pane: &str,
        text: &str,
        about: ErrandAbout,
    ) -> BoxFuture<'static, Result<String, String>> {
        let errands = self.clone();
        let (pane, text) = (pane.to_owned(), text.to_owned());
        async move { errands.start(&pane, &text, about).await }.boxed()
    }

    fn state(&self, id: &str) -> Option<ErrandState> {
        VoiceErrands::state(self, id)
    }
}

/// The voices the call tells apart ([`VoiceHelper`]'s speakers).
pub trait Speakers: Send + Sync {
    fn with(&self, use_them: &mut dyn FnMut(&mut SpeakerTracker));
}

impl Speakers for VoiceHelper {
    fn with(&self, use_them: &mut dyn FnMut(&mut SpeakerTracker)) {
        use_them(&mut self.speakers());
    }
}

impl Speakers for Mutex<SpeakerTracker> {
    fn with(&self, use_them: &mut dyn FnMut(&mut SpeakerTracker)) {
        use_them(&mut self.lock().unwrap_or_else(|poison| poison.into_inner()));
    }
}

/// What the companion's routes work with; unset parts are Bun's defaults.
pub struct CompanionOptions {
    pub router: Arc<dyn Fn() -> Option<Arc<dyn Router>> + Send + Sync>,
    pub front: Arc<dyn Fn() -> Option<Arc<dyn Front>> + Send + Sync>,
    pub errands: Option<Arc<dyn Errands>>,
    /// voice.json's `errand_folder`.
    pub errand_folder: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The front's web searches, with a front.
    pub research: Arc<dyn Fn() -> Option<VoiceResearch> + Send + Sync>,
    /// The companion's MCP tools, with a front.
    pub tools: Arc<dyn Fn() -> Option<VoiceTools> + Send + Sync>,
    /// The call the helper runs now.
    pub current_call: CurrentCall,
    pub memory: Option<Arc<dyn Memory>>,
    /// Its long-term memory files, shown and deleted in its panel.
    pub memory_files: Option<CompanionMemoryFiles>,
    /// The jobs' answers nobody heard yet.
    pub waiting: Option<Arc<WaitingAnswers>>,
    pub speakers: Option<Arc<dyn Speakers>>,
    /// The light voice the call has ([`super::routes::light_voice`]).
    pub light_voice: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// What started the sessions' turns.
    pub causes: Arc<TurnCauses>,
    /// Where a long answer is whole.
    pub answers_dir: PathBuf,
    /// The chat composers' upload folder, images typed turns name.
    pub uploads: PathBuf,
    /// ROAMGATE_VOICE_DEBUG is set (not empty).
    pub debug: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The voice's timing lines.
    pub log: Logger,
    /// console.error.
    pub errors: ErrorSink,
    pub clock: Arc<dyn Clock>,
}

impl Default for CompanionOptions {
    fn default() -> Self {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        Self {
            router: Arc::new(|| None),
            front: Arc::new(|| None),
            errands: None,
            errand_folder: Arc::new(|| None),
            research: Arc::new(|| None),
            tools: Arc::new(|| None),
            current_call: Arc::new(|| None),
            memory: None,
            memory_files: None,
            waiting: None,
            speakers: None,
            light_voice: Arc::new(|| None),
            causes: Arc::new(TurnCauses::new(clock.clone())),
            answers_dir: default_answers_dir(),
            uploads: upload_root(),
            debug: Arc::new(|| {
                std::env::var_os("ROAMGATE_VOICE_DEBUG").is_some_and(|value| !value.is_empty())
            }),
            log: Logger::silent(),
            errors: Arc::new(|line| eprintln!("{line}")),
            clock,
        }
    }
}

/// The companion's routes.
#[derive(Clone)]
pub struct CompanionRoutes(Arc<CompanionOptions>);

/// `route` as a page that knows `routes` can take it. A page of an older
/// build does not list them, and takes a route it does not know for one to
/// a session: a remark to the voice itself is held there, anything else
/// goes to the agent on screen.
pub fn legacy_route(route: FrontReply, routes: Option<&Value>) -> FrontReply {
    let known: Vec<String> = match routes {
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => LEGACY_ROUTES.iter().map(|r| (*r).to_owned()).collect(),
    };
    let knows = |to: &str| known.iter().any(|k| k == to);
    let to = route.to().to_owned();
    if knows(&to) {
        return route;
    }
    let said = |route: &FrontReply| match route.str("reply").filter(|r| !r.is_empty()) {
        Some(reply) if knows("self") => reply_route("self", reply),
        _ => bare("nobody"),
    };
    // A search it cannot follow: what the front said of it, at least.
    if ["web", "tool", "reset", "dismiss"].contains(&to.as_str()) {
        return said(&route);
    }
    bare(if to == "self" { "nobody" } else { "current" })
}

fn bare(to: &str) -> FrontReply {
    let mut route = Map::new();
    route.insert("to".into(), json!(to));
    FrontReply(route)
}

fn reply_route(to: &str, reply: &str) -> FrontReply {
    let mut route = bare(to);
    route.0.insert("reply".into(), json!(reply));
    route
}

/// The state a page gave the front, its web searches and its tools.
pub fn with_searches(
    context: &str,
    research: Option<&VoiceResearch>,
    tools: Option<&VoiceTools>,
    now: f64,
) -> String {
    let searches = research
        .map(|r| research_context(&r.list(), now))
        .unwrap_or_default();
    let using = tools
        .map(|t| tools_context(&t.configured(), &t.list(), t.held_job(None).as_ref(), now))
        .unwrap_or_default();
    // What the user listens to lately, and what waits on them on the board.
    let taste = tools.map(VoiceTools::taste_line).unwrap_or_default();
    let work = tools.map(VoiceTools::work_line).unwrap_or_default();
    [context.to_owned(), searches, using, taste, work]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

static FRENCH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(le|la|les|est|une|des|du|pour|avec|dans|quel|quelle|quels|c'est|qu'est|horaires|demain|aujourd'hui)\b|[çèêàù]").unwrap()
});

fn looks_french(text: &str) -> bool {
    // JavaScript's \b is ASCII: a word next to an accented letter is not
    // one, which Rust's Unicode \b would take.
    FRENCH.find_iter(text).any(|found| {
        let word = found.as_str();
        if word.chars().count() == 1 && "çèêàùÇÈÊÀÙ".contains(word) {
            return true;
        }
        let before = text[..found.start()].chars().next_back();
        let after = text[found.end()..].chars().next();
        let ascii_word = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        !ascii_word(before) && !ascii_word(after)
    })
}

/// A front's "forget": a background session deletes it; said here at once.
pub fn forget_route(route: &FrontReply, said: &str, memory: Option<&dyn Memory>) -> FrontReply {
    let french = looks_french(said);
    let Some(memory) = memory else {
        return reply_route(
            "self",
            if french {
                "Je n'ai pas de mémoire à effacer d'ici."
            } else {
                "I have no memory to clear from here."
            },
        );
    };
    memory.forget(route.str("what").unwrap_or(""));
    match route.str("reply").filter(|r| !r.is_empty()) {
        Some(reply) => reply_route("self", reply),
        None => reply_route(
            "self",
            if french {
                "D'accord, j'oublie ça."
            } else {
                "OK, I'll forget that."
            },
        ),
    }
}

/// A front's "web" route with its search started (`job`), and what is
/// said at once; "web_cancel" done, said as "self". Without searches
/// here, it is said that it cannot look.
pub fn web_route(route: &FrontReply, said: &str, research: Option<&VoiceResearch>) -> FrontReply {
    let french = looks_french(said);
    let reply = route.str("reply").filter(|r| !r.is_empty());
    if route.to() == "web_cancel" {
        let cancelled = match (research, route.str("search").filter(|s| !s.is_empty())) {
            (None, _) => Vec::new(),
            (Some(research), Some(search)) => {
                if research.cancel(search) {
                    vec![search.to_owned()]
                } else {
                    Vec::new()
                }
            }
            (Some(research), None) => research.cancel_all(),
        };
        let said = reply.unwrap_or(match (cancelled.is_empty(), french) {
            (false, true) => "C'est arrêté.",
            (false, false) => "Stopped.",
            (true, true) => "Il n'y a pas de recherche en cours.",
            (true, false) => "No search is running.",
        });
        return reply_route("self", said);
    }
    let asked = js::trim(route.str("query").unwrap_or(""));
    let query = if asked.is_empty() { said } else { asked };
    let job = research.and_then(|r| r.start(query));
    match job.filter(|job| job.status == crate::companion::research::ResearchStatus::Searching) {
        None => reply_route(
            "self",
            match (research.is_some(), french) {
                (false, true) => "Je ne peux pas chercher sur le web d'ici.",
                (false, false) => "I can't search the web from here.",
                (true, true) => "Je n'arrive pas à lancer la recherche pour l'instant.",
                (true, false) => "I can't start that search right now.",
            },
        ),
        Some(job) => {
            let mut out = bare("web");
            out.0.insert("query".into(), json!(query));
            out.0.insert("job".into(), json!(job.id));
            out.0.insert(
                "reply".into(),
                json!(reply.unwrap_or(if french {
                    "Je regarde ça sur le web, je te redis."
                } else {
                    "Let me look that up, I'll tell you."
                })),
            );
            out
        }
    }
}

/// A front's "tool" route with its job started (`job`), and what is said
/// at once; "tool_confirm" makes the held call, only when what was said
/// is a yes, as a "tool" route following the job that makes it;
/// "tool_cancel" forgets it, said as "self" (or, with a corrected `task`,
/// started as "tool"). Without tools here, it is said that they cannot be
/// used.
pub fn tool_route(
    route: &FrontReply,
    said: &str,
    tools: Option<&VoiceTools>,
    on_call: bool,
) -> FrontReply {
    let french = looks_french(said);
    let Some(tools) = tools else {
        return reply_route(
            "self",
            if french {
                "Je n'ai pas d'outils pour ça d'ici."
            } else {
                "I don't have tools for that here."
            },
        );
    };
    let reply = route.str("reply").filter(|r| !r.is_empty());
    let action = route.str("action");
    if route.to() == "tool_cancel" {
        let declined = tools.decline(action);
        // A change: the corrected request, read back again in its turn.
        if let Some(task) = route.str("task").filter(|t| !js::trim(t).is_empty()) {
            let mut corrected = bare("tool");
            corrected.0.insert("task".into(), json!(task));
            if let Some(reply) = route.0.get("reply") {
                corrected.0.insert("reply".into(), reply.clone());
            }
            return tool_route(&corrected, said, Some(tools), on_call);
        }
        return reply_route(
            "self",
            reply.unwrap_or(match (declined, french) {
                (true, true) => "D'accord, je n'envoie rien.",
                (true, false) => "OK, I won't send anything.",
                (false, true) => "Rien n'attendait de confirmation.",
                (false, false) => "Nothing was waiting for a yes.",
            }),
        );
    }
    if route.to() == "tool_confirm" {
        let held = tools.held_job(action).or_else(|| tools.held_job(None));
        // The user's own yes, now, to a call still held: else nothing runs.
        let job = held
            .as_ref()
            .and_then(|held| tools.confirm(said, Some(&held.id)));
        let Some(job) = job else {
            return reply_route(
                "self",
                match (held.is_some(), french) {
                    (false, true) => "Rien n'attend de confirmation.",
                    (false, false) => "Nothing is waiting for a yes.",
                    (true, true) => {
                        "Je n'ai rien fait. Dis oui pour confirmer, ou non pour annuler."
                    }
                    (true, false) => {
                        "I haven't done anything. Say yes to confirm, or no to cancel."
                    }
                },
            );
        };
        let mut out = bare("tool");
        out.0.insert("task".into(), json!(job.question));
        out.0.insert("job".into(), json!(job.id));
        out.0.insert(
            "reply".into(),
            json!(reply.unwrap_or(if french { "C'est parti." } else { "Doing it." })),
        );
        return out;
    }
    let asked = js::trim(route.str("task").unwrap_or(""));
    let task = if asked.is_empty() { said } else { asked };
    let job = tools.start(task, on_call);
    match job.filter(|job| job.status == crate::companion::research::ResearchStatus::Searching) {
        None => reply_route(
            "self",
            if french {
                "Je n'arrive pas à lancer ça pour l'instant."
            } else {
                "I can't start that right now."
            },
        ),
        Some(job) => {
            let mut out = bare("tool");
            out.0.insert("task".into(), json!(task));
            out.0.insert("job".into(), json!(job.id));
            out.0.insert(
                "reply".into(),
                json!(reply.unwrap_or(if french { "Je m'en occupe." } else { "On it." })),
            );
            out
        }
    }
}

/// A context note on one line, kept short (shared/voiceMessage.ts).
pub fn voice_context_note(context: Option<&str>) -> String {
    static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let one_line = SPACES.replace_all(context.unwrap_or(""), " ");
    js::slice16(js::trim(&one_line), 0, Some(600))
}

/// Words said by voice, marked so (shared/voiceMessage.ts voiceMessage):
/// `[Voice] text`, or `[Voice, interrupted you at: "sentence"] text`; with
/// a context note, the words quoted and the note after them.
pub fn voice_message(text: &str, interrupted_at: Option<&str>, context: Option<&str>) -> String {
    let note = voice_context_note(context);
    let body = if note.is_empty() {
        text.to_owned()
    } else {
        format!("{} (Context: {note})", js::quote(text))
    };
    match interrupted_at.filter(|at| !at.is_empty()) {
        Some(at) => format!("[Voice, interrupted you at: {}] {body}", js::quote(at)),
        None => format!("[Voice] {body}"),
    }
}

/// Whether a page's session entry is one (`isSessionInfo`).
fn is_session_info(value: &Value) -> bool {
    let Some(session) = value.as_object() else {
        return false;
    };
    if let Some(active) = session.get("active")
        && !active.as_f64().is_some_and(f64::is_finite)
    {
        return false;
    }
    [
        "id",
        "machine",
        "workspace",
        "title",
        "folder",
        "agent",
        "status",
    ]
    .iter()
    .all(|key| {
        session
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|text| js::len16(text) < 500)
    })
}

fn context_of(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|text| js::slice16(text, 0, Some(MAX_CONTEXT_CHARS)))
        .unwrap_or_default()
}

fn trimmed(body: Option<&Map<String, Value>>, key: &str, max: i64) -> String {
    body.and_then(|b| b.get(key))
        .and_then(Value::as_str)
        .map(|text| js::slice16(js::trim(text), 0, Some(max)))
        .unwrap_or_default()
}

fn verdict(value: Option<&Value>) -> Option<VoiceVerdict> {
    match value.and_then(Value::as_str) {
        Some("user") => Some(VoiceVerdict::User),
        Some("other") => Some(VoiceVerdict::Other),
        _ => None,
    }
}

fn not_found(message: &str) -> Answer {
    Answer::error(404, message)
}

impl CompanionRoutes {
    pub fn new(options: CompanionOptions) -> Self {
        Self(Arc::new(options))
    }

    fn now(&self) -> f64 {
        self.0.clock.now() as f64
    }

    fn debug(&self) -> bool {
        (self.0.debug)()
    }

    fn error(&self, line: &str) {
        (self.0.errors)(line);
    }

    /// What the companion adds to GET /api/voice, its front (or router)
    /// started now, so the first thing said does not wait for it.
    pub fn status(&self) -> CompanionStatus {
        let fronting = (self.0.front)();
        let routing = if fronting.is_some() {
            None
        } else {
            (self.0.router)()
        };
        if let Some(front) = &fronting {
            front.warm();
        }
        if let Some(router) = &routing {
            router.warm();
        }
        CompanionStatus {
            route: fronting.is_some() || routing.is_some(),
            front: fronting.is_some(),
            epoch: match (&fronting, &self.0.memory) {
                (Some(_), Some(memory)) => Some(memory.epoch() as f64),
                _ => None,
            },
        }
    }

    /// The answer for `request`, None when its path is not one of these.
    pub async fn handle(&self, request: &Request) -> Option<Answer> {
        let path = request.path.as_str();
        let method = request.method.as_str();
        if let Some(rest) = path.strip_prefix("/api/voice/companion/memories")
            && self.0.memory_files.is_some()
            && (rest.is_empty()
                || (rest.starts_with('/') && !rest[1..].contains('/') && rest.len() > 1))
        {
            return Some(self.memories(request, rest.strip_prefix('/')).await);
        }
        if path.starts_with("/api/voice/answers") {
            return Some(self.answers(request));
        }
        Some(match (method, path) {
            ("POST", "/api/voice/companion/reset") => {
                if !request.has_voice_header() {
                    return Some(needs_header());
                }
                let epoch = self.reset_companion((self.0.front)().as_deref());
                Answer::json(200, json!({ "epoch": epoch }))
            }
            ("GET", "/api/voice/image") => self.image(request).await,
            ("POST", "/api/voice/forward") => self.forward(request).await,
            ("GET", "/api/voice/research") => {
                let research = (self.0.research)();
                match request.query_param("job") {
                    None => Answer::json(
                        200,
                        json!({"jobs": research.map(|r| r.list().iter().map(|j| j.to_json()).collect::<Vec<_>>()).unwrap_or_default()}),
                    ),
                    Some(job) => match research.and_then(|r| r.state(&job)) {
                        Some(state) => Answer::json(200, state.to_json()),
                        None => not_found("No such search."),
                    },
                }
            }
            ("POST", "/api/voice/research/cancel") => {
                if !request.has_voice_header() {
                    return Some(needs_header());
                }
                let job = request
                    .json_body()
                    .and_then(|b| b.get("job").and_then(Value::as_str).map(str::to_owned));
                let cancelled = match ((self.0.research)(), job) {
                    (None, _) => Vec::new(),
                    (Some(research), Some(job)) => {
                        if research.cancel(&job) {
                            vec![job]
                        } else {
                            Vec::new()
                        }
                    }
                    (Some(research), None) => research.cancel_all(),
                };
                Answer::json(200, json!({ "cancelled": cancelled }))
            }
            ("GET", "/api/voice/tools") => {
                let tools = (self.0.tools)();
                match request.query_param("job") {
                    None => Answer::json(
                        200,
                        json!({"jobs": tools.map(|t| t.list().iter().map(|j| j.to_json()).collect::<Vec<_>>()).unwrap_or_default()}),
                    ),
                    Some(job) => match tools.and_then(|t| t.state(&job)) {
                        Some(state) => Answer::json(200, state.to_json()),
                        None => not_found("No such job."),
                    },
                }
            }
            ("POST", "/api/voice/tools/cancel") => {
                if !request.has_voice_header() {
                    return Some(needs_header());
                }
                let job = request
                    .json_body()
                    .and_then(|b| b.get("job").and_then(Value::as_str).map(str::to_owned));
                let cancelled = match ((self.0.tools)(), job) {
                    (None, _) => Vec::new(),
                    (Some(tools), Some(job)) => {
                        if tools.cancel(&job) {
                            vec![job]
                        } else {
                            Vec::new()
                        }
                    }
                    (Some(tools), None) => tools.cancel_all(),
                };
                Answer::json(200, json!({ "cancelled": cancelled }))
            }
            ("POST", "/api/voice/tools/answer") => self.tool_answer(request),
            ("GET", "/api/voice/errand") => {
                let job = request.query_param("job").unwrap_or_default();
                let state = self.0.errands.as_ref().and_then(|e| e.state(&job));
                // How the work went, whoever follows it.
                if let (Some(state), Some(memory)) = (&state, &self.0.memory)
                    && state.done
                    && let Some(answer) = state.answer.as_deref().filter(|a| !a.is_empty())
                {
                    memory.record(Note::new(MemoryKind::Answer, answer));
                }
                match state {
                    Some(state) => Answer::json(200, state.to_json()),
                    None => not_found("No such errand."),
                }
            }
            ("POST", "/api/voice/event") => self.event(request).await,
            ("POST", "/api/voice/route") => self.route(request).await,
            _ => return None,
        })
    }

    /// Forgets everything the companion knows, by voice or from its button.
    fn reset_companion(&self, fronting: Option<&dyn Front>) -> i64 {
        let epoch = self.0.memory.as_ref().map_or(0, |memory| memory.reset());
        if let Some(front) = fronting {
            front.restart();
        }
        if let Some(research) = (self.0.research)() {
            research.forget();
        }
        if let Some(tools) = (self.0.tools)() {
            tools.forget();
        }
        let mut fields = LogFields::new();
        fields.insert("epoch".into(), json!(epoch));
        self.0.log.debug("companion memory reset", Some(&fields));
        epoch
    }

    /// Keeps what a turn did, for the next calls.
    fn remember(&self, said: &str, route: &FrontReply) {
        let Some(memory) = &self.0.memory else {
            return;
        };
        let to = route.to();
        if to == "nobody" || to == "reset" {
            return;
        }
        memory.record(Note::new(MemoryKind::Heard, said));
        if let Some(reply) = route.str("reply").filter(|r| !r.is_empty()) {
            memory.record(Note::new(MemoryKind::Said, reply));
        }
        let note = |kind, text: &str, who: Option<&str>| {
            let note = Note::new(kind, text);
            match who {
                Some(who) => note.by(who),
                None => note,
            }
        };
        let filled = |key: &str| route.str(key).filter(|v| !v.is_empty());
        match to {
            "current" | "send" => memory.record(note(
                MemoryKind::Work,
                route.str("words").unwrap_or(said),
                if to == "send" {
                    route.str("say")
                } else {
                    Some("the current session")
                },
            )),
            "ranger" | "reviews" | "errand" => memory.record(note(
                MemoryKind::Work,
                said,
                Some(route.str("say").unwrap_or(to)),
            )),
            "web" => memory.record(note(
                MemoryKind::Lookup,
                filled("query").unwrap_or(said),
                None,
            )),
            "tool" => memory.record(note(
                MemoryKind::Lookup,
                filled("task").unwrap_or(said),
                Some("tools"),
            )),
            _ => {}
        }
    }

    /// The sessions a page lists, those of the errands folder marked.
    fn route_sessions(&self, value: Option<&Value>) -> Vec<VoiceSessionInfo> {
        let folder = (self.0.errand_folder)().map(|f| f.trim_end_matches('/').to_owned());
        let Some(Value::Array(list)) = value else {
            return Vec::new();
        };
        list.iter()
            .filter(|each| is_session_info(each))
            .take(200)
            .map(|each| {
                let mut session = VoiceSessionInfo::from_json(each);
                if let Some(folder) = folder.as_deref().filter(|f| !f.is_empty())
                    && (session.folder == folder
                        || session.folder.starts_with(&format!("{folder}/")))
                {
                    session.errands = true;
                }
                session
            })
            .collect()
    }

    /// The state a page gave the front, with the answers waiting.
    fn with_waiting(&self, context: String) -> String {
        let waiting = self
            .0
            .waiting
            .as_ref()
            .map(|waiting| waiting.context())
            .unwrap_or_default();
        [context, waiting]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    async fn memories(&self, request: &Request, file: Option<&str>) -> Answer {
        if !request.has_voice_header() {
            return needs_header();
        }
        let Some(files) = self.0.memory_files.clone() else {
            return Answer::empty(405);
        };
        let file = match file.map(decode_uri_component) {
            None => None,
            Some(Ok(file)) => Some(file),
            Some(Err(_)) => return Answer::empty(405),
        };
        match (request.method.as_str(), file) {
            ("GET", None) => {
                let listed = tokio::task::spawn_blocking(move || files.list())
                    .await
                    .unwrap_or_default();
                Answer::json(
                    200,
                    json!({"memories": listed.iter().map(|m| m.to_json()).collect::<Vec<_>>()}),
                )
            }
            ("DELETE", Some(file)) => {
                let name = file.clone();
                let removed = tokio::task::spawn_blocking(move || {
                    let named = files.read(&name)?;
                    files.remove(&name).then_some(named)
                })
                .await
                .ok()
                .flatten();
                let Some(named) = removed else {
                    return not_found("No such memory.");
                };
                // The summary may say it too: the next session drops that too.
                if let Some(memory) = &self.0.memory {
                    memory.forget(&format!("{}: {}", named.name, named.description));
                }
                Answer::json(200, json!({ "deleted": file }))
            }
            _ => Answer::empty(405),
        }
    }

    fn answers(&self, request: &Request) -> Answer {
        if !request.has_voice_header() {
            return needs_header();
        }
        let Some(waiting) = &self.0.waiting else {
            return not_found("No answers kept here.");
        };
        match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/voice/answers") => match request.query_param("job") {
                None => Answer::json(
                    200,
                    json!({"answers": waiting.list().iter().map(|kept| json!({
                        "job": kept.job,
                        "label": kept.label,
                        "question": kept.question,
                        "at": js::number(kept.at),
                        "mentioned": kept.mentioned,
                        "chars": js::len16(&kept.answer),
                    })).collect::<Vec<_>>()}),
                ),
                Some(job) => match waiting.get(&job) {
                    Some(kept) => Answer::json(200, kept.to_json()),
                    None => not_found("No such answer."),
                },
            },
            ("POST", "/api/voice/answers/mentioned") => {
                let body = request.json_body();
                let jobs: Vec<&str> = body
                    .as_ref()
                    .and_then(|b| b.get("jobs"))
                    .and_then(Value::as_array)
                    .map(|list| list.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                Answer::json(200, json!({ "mentioned": waiting.mention(&jobs) }))
            }
            ("POST", "/api/voice/answers/heard") => {
                let job = request
                    .json_body()
                    .and_then(|b| b.get("job").and_then(Value::as_str).map(str::to_owned))
                    .unwrap_or_default();
                if !job.is_empty() && waiting.heard(&job) {
                    Answer::json(200, json!({ "heard": job }))
                } else {
                    not_found("No such answer.")
                }
            }
            _ => Answer::empty(405),
        }
    }

    async fn image(&self, request: &Request) -> Answer {
        let path = request.query_param("path").unwrap_or_default();
        let image = tokio::task::spawn_blocking(move || {
            let (file, content_type) = voice_image(&path)?;
            std::fs::read(file).ok().map(|bytes| (bytes, content_type))
        })
        .await
        .ok()
        .flatten();
        let Some((bytes, content_type)) = image else {
            return Answer::text(404, "not found");
        };
        let mut answer = Answer {
            status: 200,
            headers: vec![("content-type".into(), content_type.into())],
            body: AnswerBody::Bytes(bytes),
        };
        for (name, value) in VOICE_IMAGE_HEADERS {
            answer = answer.with(name, value);
        }
        answer
    }

    async fn forward(&self, request: &Request) -> Answer {
        if !request.has_voice_header() {
            return needs_header();
        }
        let body = request.json_body();
        let body = body.as_ref().and_then(Value::as_object);
        let pane = body
            .and_then(|b| b.get("pane"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let words = trimmed(body, "words", 8000);
        let one_slash = pane
            .split_once('/')
            .is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !b.contains('/'));
        if !one_slash || words.is_empty() {
            return Answer::error(400, "A session and words are needed.");
        }
        let Some(errands) = &self.0.errands else {
            return not_found("No jobs here.");
        };
        // Who answers what: kept with the answer, for a page gone meanwhile.
        let text = |key: &str, max: i64| {
            body.and_then(|b| b.get(key))
                .and_then(Value::as_str)
                .map(|t| js::slice16(js::trim(t), 0, Some(max)))
        };
        let about = ErrandAbout {
            label: text("label", 80),
            question: text("question", 2000),
        };
        match errands.start(pane, &words, about).await {
            Ok(job) => {
                if self.debug() {
                    self.error(&format!(
                        "[voice] companion job {job} on {pane}: {}",
                        js::slice16(&words, 0, Some(200))
                    ));
                }
                Answer::json(200, json!({ "job": job }))
            }
            Err(message) => Answer::error(502, message),
        }
    }

    fn tool_answer(&self, request: &Request) -> Answer {
        if !request.has_voice_header() {
            return needs_header();
        }
        let body = request.json_body();
        let job = body
            .as_ref()
            .and_then(|b| b.get("job"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let answer = body
            .as_ref()
            .and_then(|b| b.get("answer"))
            .and_then(Value::as_str);
        if job.is_empty() || !matches!(answer, Some("yes" | "no")) {
            return Answer::error(400, r#"A job and its answer ("yes" or "no") are needed."#);
        }
        let Some(tools) = (self.0.tools)().filter(|t| t.held_job(Some(&job)).is_some()) else {
            return Answer::error(409, "Nothing is waiting for a yes.");
        };
        if answer == Some("no") {
            tools.decline(Some(&job));
            return Answer::json(200, json!({ "declined": job }));
        }
        match tools.approve(Some(&job)) {
            Some(making) => {
                if self.debug() {
                    self.error(&format!("[voice] held call of {job} confirmed by a click"));
                }
                Answer::json(200, json!({ "job": making.to_json() }))
            }
            None => Answer::error(503, "Too many jobs run now: try again in a moment."),
        }
    }

    async fn event(&self, request: &Request) -> Answer {
        let fronting = (self.0.front)();
        let Some(front) = fronting.filter(|_| request.has_voice_header()) else {
            return Answer::json(200, json!({ "reply": "" }));
        };
        let body = request.json_body();
        let body = body.as_ref().and_then(Value::as_object);
        let kind = match body.and_then(|b| b.get("kind")).and_then(Value::as_str) {
            Some("answer") => "answer",
            Some("progress") => "progress",
            _ => "event",
        };
        let max = match kind {
            "event" => MAX_EVENT_CHARS,
            "progress" => MAX_PROGRESS_CHARS,
            _ => MAX_ANSWER_CHARS as i64,
        };
        let event = trimmed(body, "event", max);
        let agent = trimmed(body, "agent", 80);
        let current = body
            .and_then(|b| b.get("current"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if event.is_empty() {
            return Answer::json(200, json!({ "reply": "" }));
        }
        // A long answer: its start, and the file where it is whole.
        let (given, file) = if kind == "answer" {
            let given = answer_for_front(&event, &self.0.answers_dir, self.now()).await;
            (given.text, given.file)
        } else {
            (event.clone(), None)
        };
        let told = if kind == "event" {
            with_turn_context(&event, body, &self.0.causes, self.now())
        } else {
            given.clone()
        };
        let started = self.0.clock.monotonic();
        let research = (self.0.research)();
        let tools = (self.0.tools)();
        let context = self.with_waiting(with_searches(
            &context_of(body.and_then(|b| b.get("context"))),
            research.as_ref(),
            tools.as_ref(),
            self.now(),
        ));
        let reply = front
            .event(FrontEventRequest {
                current,
                event: FrontEvent {
                    text: told.clone(),
                    kind: (kind != "event").then(|| kind.to_owned()),
                    agent: (!agent.is_empty()).then(|| agent.clone()),
                },
                sessions: self.route_sessions(body.and_then(|b| b.get("sessions"))),
                context: Some(context),
                timeout_ms: None,
            })
            .await;
        if let Some(memory) = &self.0.memory {
            if kind == "answer" {
                let note = Note::new(MemoryKind::Answer, given.clone());
                memory.record(if agent.is_empty() {
                    note
                } else {
                    note.by(agent.clone())
                });
            }
            if !reply.is_empty() {
                memory.record(Note::new(MemoryKind::Said, reply.clone()));
            }
        }
        let front_ms = js::round(self.0.clock.monotonic() - started);
        if self.debug() {
            self.error(&format!(
                "[voice] front told {kind} in {} ms: {} <- {}",
                js::number_text(front_ms),
                js::quote(&reply),
                js::slice16(&told, 0, Some(300))
            ));
        }
        let mut fields = LogFields::new();
        fields.insert("kind".into(), json!(kind));
        fields.insert("front_ms".into(), js::number(front_ms));
        fields.insert(
            "said".into(),
            json!(if reply.is_empty() { "no" } else { "yes" }),
        );
        self.0.log.debug("voice front told", Some(&fields));
        match file {
            Some(file) => Answer::json(
                200,
                json!({ "reply": reply, "file": file.to_string_lossy() }),
            ),
            None => Answer::json(200, json!({ "reply": reply })),
        }
    }

    async fn route(&self, request: &Request) -> Answer {
        let fronting = (self.0.front)();
        let routing = if fronting.is_some() {
            None
        } else {
            (self.0.router)()
        };
        if !request.has_voice_header() || (routing.is_none() && fronting.is_none()) {
            return Answer::json(200, json!({ "to": "current" }));
        }
        let body = request.json_body().and_then(|b| match b {
            Value::Object(map) => Some(map),
            _ => None,
        });
        let turn = Turn::read(self, body, fronting, routing);
        if turn.said.is_empty() || (turn.current.is_empty() && turn.fronting.is_none()) {
            return Answer::json(200, json!({ "to": "current" }));
        }
        let streaming = turn.stream && turn.fronting.is_some();
        if !streaming {
            return Answer::json(200, self.decide(turn, None).await.to_json());
        }
        let (chunks, body) = mpsc::unbounded_channel::<Vec<u8>>();
        // Taken once the route is written: the stream ends then, whoever
        // still holds the early words' teller.
        let chunks = Arc::new(Mutex::new(Some(chunks)));
        let send = |chunks: &Mutex<Option<mpsc::UnboundedSender<Vec<u8>>>>, value: Value| {
            if let Some(chunks) = chunks.lock().unwrap().as_ref() {
                let _ = chunks.send(format!("{}\n", js::stringify(&value)).into_bytes());
            }
        };
        let early = chunks.clone();
        let tell: Arc<dyn Fn(EarlyReply) + Send + Sync> = Arc::new(move |said: EarlyReply| {
            send(
                &early,
                json!({"early": {"to": said.to, "reply": said.reply}}),
            );
        });
        let routes = self.clone();
        tokio::spawn(async move {
            let decided = tokio::spawn(async move { routes.decide(turn, Some(tell)).await }).await;
            let route = match decided {
                Ok(route) => route.to_json(),
                Err(_) => json!({ "to": "current" }),
            };
            send(&chunks, route);
            chunks.lock().unwrap().take();
        });
        Answer {
            status: 200,
            headers: vec![
                ("content-type".into(), "application/x-ndjson".into()),
                ("cache-control".into(), "no-store".into()),
            ],
            body: AnswerBody::Stream(StreamBody::new(body)),
        }
    }

    /// Who a turn's words are for, and what is done with them.
    async fn decide(
        &self,
        turn: Turn,
        tell: Option<Arc<dyn Fn(EarlyReply) + Send + Sync>>,
    ) -> FrontReply {
        let started = self.0.clock.monotonic();
        let timing = Arc::new(Mutex::new(FrontTiming::default()));
        let fronting = turn.fronting.clone();
        let research = if fronting.is_some() {
            (self.0.research)()
        } else {
            None
        };
        let tools = if fronting.is_some() {
            (self.0.tools)()
        } else {
            None
        };
        let call = (self.0.current_call)();
        let said = turn.said.clone();
        let now = self.now();
        let mut route = if let Some(front) = &fronting {
            // Images pasted with typed words: the front sees them.
            let images = if turn.typed {
                let (said, root) = (said.clone(), self.0.uploads.clone());
                tokio::task::spawn_blocking(move || uploaded_images(&said, &root))
                    .await
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let context = [turn.context.clone(), skipped_context(&turn.skipped, now)]
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let call_text = call_lines(&CallFacts {
                recent: Some(turn.recent.clone()).filter(|r| !r.is_empty()),
                interrupted_at: Some(turn.interrupted_at.clone()).filter(|r| !r.is_empty()),
                music: call_music(call.as_deref()).map(str::to_owned),
                light_voice: (self.0.light_voice)(),
            });
            front
                .turn(FrontTurn {
                    current: turn.current.clone(),
                    said: said.clone(),
                    sessions: turn.sessions.clone(),
                    context: Some(self.with_waiting(with_searches(
                        &context,
                        research.as_ref(),
                        tools.as_ref(),
                        now,
                    ))),
                    call: Some(call_text).filter(|c| !c.is_empty()),
                    voice: turn.voice.clone(),
                    voices: turn.voices.clone(),
                    timeout_ms: (!images.is_empty()).then_some(FRONT_IMAGE_TIMEOUT_MS),
                    on_reply: tell,
                    timing: Some(timing.clone()),
                    images,
                })
                .await
        } else if let Some(router) = &turn.routing {
            let routed = router
                .route(RouteRequest {
                    current: turn.current.clone(),
                    said: said.clone(),
                    sessions: turn.sessions.clone(),
                    voice: turn.voice.clone(),
                    timeout_ms: None,
                })
                .await;
            match routed.to_json() {
                Value::Object(map) => FrontReply(map),
                _ => FrontReply::current(),
            }
        } else {
            FrontReply::current()
        };
        // Words skipped earlier, routed now: only words the user said and
        // were listed; they are what is handled, not the complaint.
        if route.0.contains_key("recovered") {
            let recovered = recovered_words(route.0.get("recovered"), &turn.skipped);
            route.0.shift_remove("recovered");
            if let Some(recovered) = recovered {
                route.0.insert("recovered".into(), json!(recovered));
            }
        }
        let as_said = route.str("recovered").unwrap_or(&said).to_owned();
        // Only the addressing is dropped, and only when what is left is
        // what was said: otherwise the words go whole.
        if let Some(given) = route.0.get("words").filter(|w| !w.is_null()).cloned() {
            let words = forwarded_words(&as_said, given.as_str());
            if words == as_said {
                route.0.shift_remove("words");
            } else {
                route.0.insert("words".into(), json!(words));
            }
        }
        let to = route.to().to_owned();
        if to == "web" || to == "web_cancel" {
            route = web_route(&route, &as_said, research.as_ref());
        }
        if ["tool", "tool_confirm", "tool_cancel"].contains(&route.to()) {
            let music = call.as_ref().is_some_and(|c| c.music());
            route = tool_route(&route, &as_said, tools.as_ref(), music);
        }
        if route.to() == "music" {
            let changed = music_route(&route.to_json(), call.as_deref(), &self.0.errors).await;
            if let Value::Object(map) = changed {
                route = FrontReply(map);
            }
        }
        // After the turn: its session answered this request before it goes.
        if route.to() == "reset"
            && let Some(front) = &fronting
        {
            self.reset_companion(Some(&**front));
        }
        let forgetting = route.to() == "forget";
        if forgetting {
            route = forget_route(&route, &said, self.0.memory.as_deref());
        }
        // An answer waiting the user does not want: dropped here, said by
        // the page.
        if route.to() == "dismiss"
            && let Some(waiting) = &self.0.waiting
        {
            let gone = waiting.dismiss(route.str("job"));
            if self.debug() {
                self.error(&format!("[voice] answers dismissed: {}", gone.join(", ")));
            }
        }
        if route.to() == "errand" {
            let pane = route.str("pane").unwrap_or("").to_owned();
            // Words typed go as typed; words said marked as such.
            let text = if turn.typed {
                as_said.clone()
            } else {
                voice_message(
                    &as_said,
                    Some(turn.interrupted_at.as_str()),
                    route.str("context"),
                )
            };
            let about = ErrandAbout {
                label: route.str("say").map(str::to_owned),
                question: Some(as_said.clone()),
            };
            let started_job = match &self.0.errands {
                None => Err("no errands set up".to_owned()),
                Some(errands) => errands.start(&pane, &text, about).await,
            };
            match started_job {
                Ok(job) => {
                    route.0.insert("job".into(), json!(job));
                }
                Err(message) => {
                    if self.debug() {
                        self.error(&format!("[voice] errand failed: {message}"));
                    }
                    // Not for the agent on screen either: held, to send by hand.
                    route = bare("nobody");
                }
            }
        }
        if self.debug() {
            self.error(&format!(
                "[voice] routed in {} ms: {} <- {}",
                js::number_text(js::round(self.0.clock.monotonic() - started)),
                js::stringify(&route.to_json()),
                js::slice16(&said, 0, Some(200))
            ));
        }
        if fronting.is_some() && !forgetting {
            self.remember(&as_said, &route);
        }
        let timed_out = timing.lock().unwrap().timed_out;
        if let (Some(mut tag), Some(speakers)) = (turn.tag.clone(), &self.0.speakers)
            && !timed_out
        {
            self.learn(&mut tag, &**speakers, &route, turn.voice.as_deref());
        }
        route.0.shift_remove("voice");
        route.0.shift_remove("naming");
        let timing = timing.lock().unwrap().clone();
        let mut fields = LogFields::new();
        let ms = |value: Option<f64>| value.map_or(Value::Null, js::number);
        fields.insert("to".into(), json!(route.to()));
        fields.insert(
            "front".into(),
            json!(if fronting.is_some() { "yes" } else { "no" }),
        );
        fields.insert("streamed".into(), json!(turn.stream && fronting.is_some()));
        fields.insert("waited_ms".into(), ms(timing.waited_ms));
        fields.insert("first_text_ms".into(), ms(timing.first_text_ms));
        fields.insert("reply_ms".into(), ms(timing.reply_ms));
        fields.insert("front_ms".into(), ms(timing.total_ms));
        fields.insert(
            "total_ms".into(),
            js::number(js::round(self.0.clock.monotonic() - started)),
        );
        fields.insert("cold".into(), json!(timing.cold));
        fields.insert("timed_out".into(), json!(timing.timed_out));
        fields.insert("said_chars".into(), json!(js::len16(&said)));
        self.0.log.debug("voice turn routed", Some(&fields));
        legacy_route(route, turn.routes.as_ref())
    }

    /// Which voice is the user's: the one whose words were taken up, or
    /// what the front said of it; and a name the companion gives a voice.
    fn learn(
        &self,
        tag: &mut VoiceTag,
        speakers: &dyn Speakers,
        route: &FrontReply,
        voice: Option<&str>,
    ) {
        let naming = route.0.get("naming").and_then(voice_naming);
        let to = route.to().to_owned();
        let said_voice = route.str("voice").map(str::to_owned);
        let verdict = verdict(route.0.get("voice"));
        let mut named = None;
        let mut learnt = String::new();
        speakers.with(&mut |tracker| {
            if let Some(naming) = &naming {
                named = Some(tracker.name(Some(&mut *tag), naming));
            }
            tracker.learn(Some(&mut *tag), &to, verdict);
            learnt = tracker.label(Some(&*tag));
        });
        if let (Some(naming), Some(named)) = (&naming, named) {
            let done = named.unwrap_or_else(|| "nothing to name".into());
            let mut fields = LogFields::new();
            fields.insert(
                "voice".into(),
                json!(
                    naming
                        .voice
                        .clone()
                        .or_else(|| tag.id.clone())
                        .unwrap_or_default()
                ),
            );
            fields.insert("name".into(), json!(naming.name));
            fields.insert(
                "role".into(),
                json!(naming.role.map(|r| r.as_str()).unwrap_or("")),
            );
            fields.insert("done".into(), json!(done));
            self.0.log.debug("voice named", Some(&fields));
            if self.debug() {
                self.error(&format!("[voice] named: {done}"));
            }
        }
        let mut fields = LogFields::new();
        fields.insert("label".into(), json!(voice.unwrap_or("")));
        fields.insert("to".into(), json!(to));
        fields.insert("verdict".into(), json!(said_voice.as_deref().unwrap_or("")));
        fields.insert("now".into(), json!(learnt));
        fields.insert("share".into(), js::number(tag.share));
        fields.insert("mixed".into(), json!(tag.mixed));
        fields.insert(
            "similarity".into(),
            json!(js::stringify(&json!(tag.similarity))),
        );
        self.0.log.debug("voice turn speaker", Some(&fields));
        if self.debug() {
            self.error(&format!(
                "[voice] speaker: [{}] routed {to}{}; now [{learnt}]",
                voice.unwrap_or(""),
                said_voice
                    .map(|v| format!(", the front says {v}"))
                    .unwrap_or_default()
            ));
        }
    }
}

/// A turn as the route request gives it.
struct Turn {
    fronting: Option<Arc<dyn Front>>,
    routing: Option<Arc<dyn Router>>,
    said: String,
    current: String,
    typed: bool,
    stream: bool,
    tag: Option<VoiceTag>,
    voice: Option<String>,
    voices: Option<String>,
    recent: String,
    interrupted_at: String,
    sessions: Vec<VoiceSessionInfo>,
    skipped: Vec<crate::companion::front::SkippedWords>,
    context: String,
    routes: Option<Value>,
}

impl Turn {
    fn read(
        routes: &CompanionRoutes,
        body: Option<Map<String, Value>>,
        fronting: Option<Arc<dyn Front>>,
        routing: Option<Arc<dyn Router>>,
    ) -> Self {
        let body = body.as_ref();
        let get = |key: &str| body.and_then(|b| b.get(key));
        let typed = get("typed") == Some(&Value::Bool(true));
        // Who said it (the helper's voices), labelled with what the call
        // taught of the user's voice.
        let tag = if typed {
            None
        } else {
            get("voice").and_then(parse_voice_tag)
        };
        let mut voice = None;
        let mut voices = None;
        if let (Some(tag), Some(speakers)) = (&tag, &routes.0.speakers) {
            speakers.with(&mut |tracker| {
                voice = Some(tracker.label(Some(tag))).filter(|l| !l.is_empty());
                // Every score behind the label, for the companion to judge.
                if fronting.is_some() {
                    voices = Some(tracker.detail(Some(tag), true)).filter(|d| !d.is_empty());
                }
            });
        }
        let skipped = if fronting.is_some() {
            skipped_words(get("skipped"), routes.now())
        } else {
            Vec::new()
        };
        Self {
            said: get("said")
                .and_then(Value::as_str)
                .map(|s| js::trim(s).to_owned())
                .unwrap_or_default(),
            current: get("current")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            typed,
            stream: get("stream") == Some(&Value::Bool(true)),
            tag,
            voice,
            voices,
            recent: trimmed(body, "recent", MAX_RECENT_CHARS),
            interrupted_at: trimmed(body, "interrupted_at", 2000),
            sessions: routes.route_sessions(get("sessions")),
            skipped,
            context: context_of(get("context")),
            routes: get("routes").cloned(),
            fronting,
            routing,
        }
    }
}

#[cfg(test)]
mod tests;
