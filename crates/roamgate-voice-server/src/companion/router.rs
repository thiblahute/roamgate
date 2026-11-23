//! Decides who each thing said by voice is for (`voice/voice-router.ts`),
//! in one background Claude Code session: it keeps what was said and asked
//! before, so "the other one" or the answer to its question make sense.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use roamgate_base::clock::{Clock, SystemClock, timeout};
use serde_json::{Map, Value, json};

use crate::companion::claude::{ClaudeCommand, ResolveCommand, SpawnProcess, Worker};
use crate::companion::cleaner::{SpawnFor, reply_object};
use crate::companion::keyed::Keyed;
use crate::config::VoiceConfig;
use crate::js;

pub const ROUTER_SYSTEM_PROMPT: &str = r#"You route what the user says aloud while talking to their coding agents by voice. They work with many agent sessions (Claude Code and others) across machines, shown in Roamgate. Speech recognition mishears names and technical words: "Roamgate" may come out as "Rome gate", "room gate" or "wrong gate", "Claude" as "cloud", "gst-plugins-rs" as "just plugins RS", "cloud-project-system" as "clock system", numbers as words. People talking nearby can be picked up too, often in French or Spanish.

Each request gives the session on screen ("current") and what was just said; the list of sessions comes when it changes. Decide who it is for, and answer with only a JSON object:

- {"to": "current"}: for the agent on screen. This is by far the most common case: anything that is a request, a question, an answer or a remark to that agent, even if it mentions another session, a branch or a project ("like the IGA-184 session did", "open the review", "switch the default to X").
- {"to": "open", "pane": "<id>", "say": "<short name>"}: the user asks to go to, open, switch to, look for or check on another session. "say" is how to name it aloud, a few words.
- {"to": "send", "pane": "<id>", "say": "<short name>"}: the user asks to tell, ask or pass something to another session's agent. The words go to it as said.
- {"to": "ranger"}: a question about other sessions or workspaces, one or several, without asking to go there: what one is doing, whether it is done or waits on them, the state of work it owns (its merge request, CI, branch or ticket), what they worked on today, which ones wait on them; or a request to manage workspaces said to Ranger by name ("Ranger, close the docker cleanup pane"). A question about the agent on screen or its own work is "current", never "ranger": "how is the rebase going?", "are you done?", "where are we?", "what is that agent you started doing?", even when it names the session on screen ("I'm asking the Roamgate session how the rebase is going"). Work the agent on screen is asked to do, creating worktrees or starting sessions included, stays "current". A question about another session is "ranger" however it is put ("if I ask you whether X is ready, can you answer?"). Ranger, Roamgate's assistant, answers it while the user stays where they are. "Go to", "open", "switch to" or "move to" a session is "open", even with "see what is happening there".
- {"to": "reviews"}: a question or request for the reviews agent, about merge or pull requests to review on the forges: what is new or waits for review in a project or an area ("anything new on GES or the RTP stack?", "find MRs touching validate"), why one was suggested ("why did you suggest 12967?"), or to suggest, dismiss or open one; or said to the reviews agent by name ("ask the reviews agent..."). A question about the merge request of a session's own work is "ranger"; a request to the agent on screen about the review it is doing is "current".
- {"to": "errand", "pane": "<id>", "say": "<short name>"}: a question or an errand not about any session, project or Roamgate: the news, football, the weather, sending a WhatsApp message or a mail, a purchase. It goes to the session marked "handles errands", which answers while the user stays where they are. Without such a session, it is "current".
- {"to": "ask", "panes": ["<id>", "<id>"], "question": "<short question>"}: only when two or three sessions fit equally and nothing said tells them apart, such as the same title on two machines. Otherwise pick the best match: a session whose own workspace or title carries the name said ("IGA-184") beats one that only mentions it among others. The question is a few words naming them, so the user can answer by voice.
- {"to": "nobody"}: not said to an agent: talk with someone nearby, on the phone, or a fragment of it.

"Said" may carry who spoke, in brackets, from the voices the microphone tells apart: [you 0.58] or [Thibault (you) 0.91] is the user's voice; [Simon 0.84] someone else known by their voice; [voice B, unknown] or [voice B, 0.07 like you] another voice (a radio, a TV, someone else in the room), with how close it is to the user's; [mixed: you + B] the user over another voice; [voice A] or [voice unclear] while the user's voice is not known yet. Words of another voice are "nobody" unless they clearly speak to an agent; for mixed ones, go by what the user says.

Talk about Roamgate itself (its voice chat, this routing, a feature idea or a bug for it) is for the session working on Roamgate's code when one is listed: "send" it there, whichever session is on screen.

Match sessions on what they are about: title, workspace, folder, branch, machine, all as the user may describe them loosely or misheard. Only use ids from the list. When unsure whether something is for the current agent, it is. Reply with the JSON object alone, never a tool call."#;

/// The words said, as a request gives them: with who spoke, in brackets,
/// when the voices are told apart (the speakers' label).
pub fn said_line(said: &str, voice: Option<&str>) -> String {
    let voice = voice
        .filter(|v| !v.is_empty())
        .map(|v| format!(" [{v}]"))
        .unwrap_or_default();
    format!("Said{voice}: {}", js::quote(said))
}

/// An agent session the user may name, as the page lists them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VoiceSessionInfo {
    /// `<connection>/<pane>`.
    pub id: String,
    pub machine: String,
    pub workspace: String,
    pub title: String,
    pub folder: String,
    pub agent: String,
    pub status: String,
    /// Minutes since its session last changed, when known.
    pub active: Option<f64>,
    /// The session general questions and errands go to.
    pub errands: bool,
}

impl VoiceSessionInfo {
    /// From the page's JSON (missing strings read as "undefined", as the
    /// TS template literals would).
    pub fn from_json(value: &Value) -> Self {
        let text = |key: &str| {
            value
                .get(key)
                .map_or_else(|| "undefined".to_owned(), js::to_text)
        };
        Self {
            id: text("id"),
            machine: text("machine"),
            workspace: text("workspace"),
            title: text("title"),
            folder: text("folder"),
            agent: text("agent"),
            status: text("status"),
            active: value.get("active").and_then(Value::as_f64),
            errands: value.get("errands") == Some(&Value::Bool(true)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceRoute {
    Current,
    Nobody,
    Open {
        pane: String,
        say: String,
    },
    Send {
        pane: String,
        say: String,
    },
    Ranger,
    /// A question for the reviews agent (the Reviews panel's chat).
    Reviews,
    Errand {
        pane: String,
        say: String,
        job: Option<String>,
    },
    Ask {
        panes: Vec<String>,
        question: String,
    },
}

impl VoiceRoute {
    pub fn to_json(&self) -> Value {
        match self {
            Self::Current => json!({"to": "current"}),
            Self::Nobody => json!({"to": "nobody"}),
            Self::Ranger => json!({"to": "ranger"}),
            Self::Reviews => json!({"to": "reviews"}),
            Self::Open { pane, say } => json!({"to": "open", "pane": pane, "say": say}),
            Self::Send { pane, say } => json!({"to": "send", "pane": pane, "say": say}),
            Self::Errand { pane, say, job } => {
                let mut out = json!({"to": "errand", "pane": pane, "say": say});
                if let Some(job) = job {
                    out["job"] = json!(job);
                }
                out
            }
            Self::Ask { panes, question } => {
                json!({"to": "ask", "panes": panes, "question": question})
            }
        }
    }
}

/// A route not decided by then goes to the agent on screen.
pub const ROUTE_TIMEOUT_MS: u64 = 8000;

static INVOKE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<invoke name="(\w+)">((?s:.*?))</invoke>"#).unwrap());
static PARAMETER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<parameter name="(\w+)">((?s:.*?))</parameter>"#).unwrap());

fn parameter_value(value: &str) -> Value {
    if !value.starts_with('[') {
        return Value::String(value.to_owned());
    }
    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned()))
}

/// The model's answer, kept to sessions it was given; anything else is
/// "current".
pub fn parse_voice_route(text: &str, ids: &HashSet<String>) -> VoiceRoute {
    // Now and then a model answers as a tool call: <invoke name="open">
    // <parameter name="pane">...</parameter>...</invoke>.
    if let Some(invoked) = INVOKE.captures(text) {
        let mut reply = Map::new();
        reply.insert("to".into(), json!(&invoked[1]));
        for parameter in PARAMETER.captures_iter(&invoked[2]) {
            reply.insert(
                parameter[1].to_owned(),
                parameter_value(js::trim(&parameter[2])),
            );
        }
        return checked(&reply, ids);
    }
    match reply_object(text) {
        Ok(Value::Object(reply)) => checked(&reply, ids),
        _ => VoiceRoute::Current,
    }
}

fn checked(reply: &Map<String, Value>, ids: &HashSet<String>) -> VoiceRoute {
    let say = reply
        .get("say")
        .and_then(Value::as_str)
        .map(|s| js::slice16(s, 0, Some(80)))
        .unwrap_or_default();
    let pane = reply
        .get("pane")
        .and_then(Value::as_str)
        .filter(|p| ids.contains(*p))
        .map(str::to_owned);
    match reply.get("to").and_then(Value::as_str) {
        Some("nobody") => VoiceRoute::Nobody,
        Some("ranger") => VoiceRoute::Ranger,
        Some("reviews") => VoiceRoute::Reviews,
        Some("open") => pane.map_or(VoiceRoute::Current, |pane| VoiceRoute::Open { pane, say }),
        Some("send") => pane.map_or(VoiceRoute::Current, |pane| VoiceRoute::Send { pane, say }),
        Some("errand") => pane.map_or(VoiceRoute::Current, |pane| VoiceRoute::Errand {
            pane,
            say,
            job: None,
        }),
        Some("ask") => {
            let panes: Vec<String> = reply
                .get("panes")
                .and_then(Value::as_array)
                .map(|panes| {
                    panes
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|p| ids.contains(*p))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let question = reply
                .get("question")
                .and_then(Value::as_str)
                .map(|q| js::slice16(q, 0, Some(300)))
                .unwrap_or_default();
            if panes.is_empty() || question.is_empty() {
                VoiceRoute::Current
            } else {
                VoiceRoute::Ask { panes, question }
            }
        }
        _ => VoiceRoute::Current,
    }
}

fn format_minutes(minutes: f64) -> String {
    if minutes < 60.0 {
        format!("{} min", js::number_text(js::round(minutes)))
    } else if minutes < 48.0 * 60.0 {
        format!("{} h", js::number_text(js::round(minutes / 60.0)))
    } else {
        format!("{} days", js::number_text(js::round(minutes / 1440.0)))
    }
}

/// A session as the router and the front read it, on one line.
pub fn voice_session_line(session: &VoiceSessionInfo) -> String {
    let mut parts = vec![
        session.id.clone(),
        session.machine.clone(),
        format!("workspace {}", session.workspace),
        session.title.clone(),
        session.folder.clone(),
        format!("{} {}", session.agent, session.status),
    ];
    if let Some(active) = session.active {
        parts.push(format!("active {} ago", format_minutes(active)));
    }
    if session.errands {
        parts.push("handles errands".into());
    }
    parts.join(" | ")
}

/// A routing request.
#[derive(Debug, Clone, Default)]
pub struct RouteRequest {
    pub current: String,
    pub said: String,
    pub sessions: Vec<VoiceSessionInfo>,
    /// Who spoke (the speakers' label), when told apart.
    pub voice: Option<String>,
    /// [`ROUTE_TIMEOUT_MS`] without one.
    pub timeout_ms: Option<u64>,
}

/// The session list last given, and to which background session.
#[derive(Default)]
struct Listed {
    generation: u64,
    list: String,
}

struct RouterInner {
    worker: Worker,
    chain: tokio::sync::Mutex<()>,
    listed: Mutex<Option<Listed>>,
    clock: Arc<dyn Clock>,
}

#[derive(Clone)]
pub struct VoiceRouter(Arc<RouterInner>);

impl VoiceRouter {
    pub fn new(spawn: SpawnProcess) -> Self {
        Self::with(spawn, Arc::new(SystemClock))
    }

    pub fn with(spawn: SpawnProcess, clock: Arc<dyn Clock>) -> Self {
        Self(Arc::new(RouterInner {
            worker: Worker::new(spawn),
            chain: tokio::sync::Mutex::new(()),
            listed: Mutex::new(None),
            clock,
        }))
    }

    pub fn warm(&self) {
        self.0.worker.warm();
    }

    /// Who `request.said` is for; the agent on screen when the model fails
    /// or is too slow. Requests go to the model one at a time.
    pub async fn route(&self, request: RouteRequest) -> VoiceRoute {
        let wait = request.timeout_ms.unwrap_or(ROUTE_TIMEOUT_MS);
        let router = self.clone();
        let routed = tokio::spawn(async move {
            let _turn = router.0.chain.lock().await;
            router.ask(&request).await
        });
        match timeout(&*self.0.clock, Duration::from_millis(wait), routed).await {
            Ok(Ok(Ok(route))) => route,
            _ => VoiceRoute::Current,
        }
    }

    async fn ask(&self, request: &RouteRequest) -> Result<VoiceRoute, String> {
        let worker = &self.0.worker;
        let ids: HashSet<String> = request.sessions.iter().map(|s| s.id.clone()).collect();
        let list = request
            .sessions
            .iter()
            .map(voice_session_line)
            .collect::<Vec<_>>()
            .join("\n");
        let asked = format!(
            "Current: {}\n{}",
            request.current,
            said_line(&request.said, request.voice.as_deref())
        );
        let send = |with_list: bool| {
            let generation = worker.generation();
            let prompt = if with_list {
                format!("Sessions:\n{list}\n\n{asked}")
            } else {
                asked.clone()
            };
            let answer = worker.ask(&prompt, None, &[]);
            let list = list.clone();
            async move {
                let answer = answer.await?;
                // A new background session started for it: it never saw the list.
                if !with_list && worker.generation() != generation {
                    return Ok(None);
                }
                *self.0.listed.lock().unwrap() = Some(Listed {
                    generation: worker.generation(),
                    list,
                });
                Ok::<_, String>(Some(answer))
            }
        };
        let known = worker.running()
            && self
                .0
                .listed
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|l| l.list == list && l.generation == worker.generation());
        let answer = match send(!known).await? {
            Some(answer) => Some(answer),
            None => send(true).await?,
        };
        Ok(parse_voice_route(&answer.unwrap_or_default(), &ids))
    }

    pub fn stop(&self) {
        self.0.worker.stop();
    }
}

/// The router `route_model` in voice.json sets up, kept while it stays the
/// same; None without one.
pub struct ConfiguredRouter {
    current: Keyed<VoiceRouter>,
    spawn: SpawnFor,
    command: ResolveCommand,
}

impl ConfiguredRouter {
    pub fn new(spawn: SpawnFor, command: ResolveCommand) -> Self {
        Self {
            current: Keyed::default(),
            spawn,
            command,
        }
    }

    /// The real sessions, with the router's prompt.
    pub fn spawning(command: ResolveCommand) -> Self {
        Self::new(
            Arc::new(|model: &str, command: &ClaudeCommand| {
                crate::companion::claude::spawn_claude(
                    model,
                    command,
                    ROUTER_SYSTEM_PROMPT,
                    &Default::default(),
                )
            }),
            command,
        )
    }

    pub fn get(&self, config: Result<&VoiceConfig, &str>) -> Option<VoiceRouter> {
        let model = config
            .ok()
            .and_then(|c| c.str("route_model"))
            .filter(|m| !m.is_empty());
        let command =
            model.map(|_| (self.command)(config.ok().and_then(|c| c.str("claude_command"))));
        let key = match (&model, &command) {
            (Some(model), Some(command)) => format!("{model} {}", command.key()),
            _ => String::new(),
        };
        let spawn = self.spawn.clone();
        let model = model.map(str::to_owned);
        self.current.get(
            &key,
            move || {
                let (model, command) = (model?, command?);
                Some(VoiceRouter::new(Arc::new(move || spawn(&model, &command))))
            },
            VoiceRouter::stop,
        )
    }
}

#[cfg(test)]
mod tests;
