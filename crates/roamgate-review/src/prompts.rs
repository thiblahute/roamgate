//! The permission prompts agents' hooks wait on (review/prompts.ts), per
//! connection: each waits until the browser answers, the hook gives up, or
//! it times out; an unanswered prompt goes back to the terminal's dialog.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use roamgate_base::clock::SharedClock;
use roamgate_protocol::file_edits::file_edit_from_arguments;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

const DETAIL_CHARS: usize = 2000;

/// What an agent's permission hook asks.
pub struct PermissionRequest {
    pub connection_id: String,
    pub pane_id: String,
    pub agent: String,
    pub tool: String,
    pub input: Value,
    pub can_always: bool,
    /// Claude's questions (AskUserQuestion), answered with the options.
    pub questions: Option<Value>,
    /// No terminal asks instead (a headless claude).
    pub no_terminal: bool,
    pub timeout_ms: u64,
    /// Resolves when the hook went away: the terminal asks now.
    pub cancel: Option<Pin<Box<dyn Future<Output = ()> + Send>>>,
}

/// The line that says what a tool would do: its command, file, or URL.
pub fn permission_summary(tool: &str, input: &Value) -> String {
    if let Some(fields) = input.as_object() {
        for key in [
            "command",
            "file_path",
            "notebook_path",
            "url",
            "pattern",
            "path",
            "query",
            "description",
        ] {
            if let Some(value) = fields.get(key).and_then(Value::as_str) {
                let trimmed = crate::js::trim(value);
                if !trimmed.is_empty() {
                    return trimmed.to_owned();
                }
            }
        }
    }
    tool.to_owned()
}

/// A push to every browser (`ReviewPush`).
pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;

struct Open {
    prompt: Value,
    connection_id: String,
    has_questions: bool,
    can_always: bool,
    finish: oneshot::Sender<Option<Value>>,
}

/// The prompts waiting, in the order they came.
#[derive(Clone)]
pub struct AgentPrompts {
    open: Arc<Mutex<IndexMap<String, Open>>>,
    publish: Publish,
    clock: SharedClock,
}

impl AgentPrompts {
    pub fn new(publish: Publish, clock: SharedClock) -> Self {
        Self {
            open: Arc::default(),
            publish,
            clock,
        }
    }

    /// The prompts of a connection.
    pub fn list(&self, connection_id: &str) -> Vec<Value> {
        self.open
            .lock()
            .unwrap()
            .values()
            .filter(|entry| entry.connection_id == connection_id)
            .map(|entry| entry.prompt.clone())
            .collect()
    }

    fn publish_for(&self, connection_id: &str) {
        let prompts = self.list(connection_id);
        (self.publish)(json!({
            "type": "prompts",
            "connectionId": connection_id,
            "prompts": prompts,
        }));
    }

    fn finish(&self, id: &str, answer: Option<Value>) -> bool {
        let entry = self.open.lock().unwrap().shift_remove(id);
        match entry {
            Some(entry) => {
                let _ = entry.finish.send(answer);
                self.publish_for(&entry.connection_id);
                true
            }
            None => false,
        }
    }

    /// Opens a prompt (listed and published at once) and waits for its
    /// answer; `None` when it went back to the terminal.
    pub fn request(
        &self,
        mut params: PermissionRequest,
    ) -> impl Future<Output = Option<Value>> + Send + 'static {
        let id = roamgate_base::paths::random_uuid();
        let created = self.clock.now();
        let detail = serde_json::to_string_pretty(&params.input)
            .ok()
            .map(|text| crate::js::head16(&text, DETAIL_CHARS).to_owned());
        let mut prompt = Map::new();
        prompt.insert("id".into(), json!(id));
        prompt.insert("connectionId".into(), json!(params.connection_id));
        prompt.insert("paneId".into(), json!(params.pane_id));
        prompt.insert("agent".into(), json!(params.agent));
        prompt.insert("tool".into(), json!(params.tool));
        prompt.insert(
            "summary".into(),
            json!(crate::js::head16(
                &permission_summary(&params.tool, &params.input),
                500
            )),
        );
        if let Some(detail) = detail {
            prompt.insert("detail".into(), json!(detail));
        }
        if let Some(edit) = file_edit_from_arguments(Some(&params.tool), &params.input) {
            prompt.insert(
                "file_edit".into(),
                serde_json::to_value(edit).unwrap_or(Value::Null),
            );
        }
        prompt.insert("canAlways".into(), json!(params.can_always));
        prompt.insert("createdAt".into(), json!(crate::js::iso(created)));
        prompt.insert(
            "expiresAt".into(),
            json!(crate::js::iso(created + params.timeout_ms as i64)),
        );
        if let Some(questions) = &params.questions {
            prompt.insert("questions".into(), questions.clone());
        }
        if params.no_terminal {
            prompt.insert("noTerminal".into(), json!(true));
        }
        let (send, receive) = oneshot::channel();
        self.open.lock().unwrap().insert(
            id.clone(),
            Open {
                prompt: Value::Object(prompt),
                connection_id: params.connection_id.clone(),
                has_questions: params.questions.is_some(),
                can_always: params.can_always,
                finish: send,
            },
        );
        self.publish_for(&params.connection_id);
        let this = self.clone();
        let sleep = self.clock.sleep(Duration::from_millis(params.timeout_ms));
        let cancel = params.cancel.take();
        async move {
            let cancel = async move {
                match cancel {
                    Some(cancel) => cancel.await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                answer = receive => answer.ok().flatten(),
                () = sleep => { this.finish(&id, None); None }
                () = cancel => { this.finish(&id, None); None }
            }
        }
    }

    /// Answers a prompt; false when it is gone or the answer does not fit.
    pub fn answer(&self, connection_id: &str, id: &str, answer: Value) -> bool {
        {
            let open = self.open.lock().unwrap();
            let Some(entry) = open.get(id) else {
                return false;
            };
            if entry.connection_id != connection_id {
                return false;
            }
            let dismiss = answer == json!("dismiss");
            if !dismiss && answer.is_object() != entry.has_questions {
                return false;
            }
            if answer == json!("always") && !entry.can_always {
                return false;
            }
        }
        self.finish(id, Some(answer))
    }

    /// Hands a prompt back to the terminal, unanswered.
    pub fn release(&self, connection_id: &str, id: &str) -> bool {
        let mine = self
            .open
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|entry| entry.connection_id == connection_id);
        mine && self.finish(id, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use roamgate_base::clock::SystemClock;

    fn setup() -> (Arc<Mutex<Vec<Value>>>, AgentPrompts) {
        let pushes: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = pushes.clone();
        let prompts = AgentPrompts::new(
            Arc::new(move |push| sink.lock().unwrap().push(push)),
            Arc::new(SystemClock),
        );
        (pushes, prompts)
    }

    fn ask(
        prompts: &AgentPrompts,
        change: impl FnOnce(&mut PermissionRequest),
    ) -> impl Future<Output = Option<Value>> {
        let mut request = PermissionRequest {
            connection_id: "local".into(),
            pane_id: "w1:p2".into(),
            agent: "Claude".into(),
            tool: "Bash".into(),
            input: json!({"command": "rm -rf build"}),
            can_always: true,
            questions: None,
            no_terminal: false,
            timeout_ms: 1_000,
            cancel: None,
        };
        change(&mut request);
        prompts.request(request)
    }

    fn first_id(prompts: &AgentPrompts) -> String {
        prompts.list("local")[0]["id"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn a_prompt_waits_for_the_browsers_answer() {
        let (pushes, prompts) = setup();
        let waiting = ask(&prompts, |_| {});
        let prompt = prompts.list("local")[0].clone();
        assert_eq!(prompt["paneId"], "w1:p2");
        assert_eq!(prompt["summary"], "rm -rf build");
        assert_eq!(prompt["canAlways"], true);
        assert_eq!(pushes.lock().unwrap().last().unwrap()["type"], "prompts");
        let id = first_id(&prompts);
        assert!(!prompts.answer("other", &id, json!("allow")));
        assert!(prompts.answer("local", &id, json!("always")));
        assert_eq!(waiting.await, Some(json!("always")));
        assert!(prompts.list("local").is_empty());
        assert_eq!(pushes.lock().unwrap().last().unwrap()["prompts"], json!([]));
        assert!(!prompts.answer("local", &id, json!("deny")));
    }

    #[tokio::test]
    async fn an_unanswered_prompt_goes_back_to_the_terminal() {
        let (_, prompts) = setup();
        assert_eq!(ask(&prompts, |r| r.timeout_ms = 20).await, None);
        let (hook, gone) = oneshot::channel::<()>();
        let waiting = ask(&prompts, |r| {
            r.cancel = Some(Box::pin(async move {
                let _ = gone.await;
            }))
        });
        drop(hook);
        assert_eq!(waiting.await, None);
        assert!(prompts.list("local").is_empty());
    }

    #[tokio::test]
    async fn always_needs_the_terminals_own_dont_ask_again_rules() {
        let (_, prompts) = setup();
        let waiting = ask(&prompts, |r| r.can_always = false);
        let id = first_id(&prompts);
        assert!(!prompts.answer("local", &id, json!("always")));
        prompts.answer("local", &id, json!("deny"));
        assert_eq!(waiting.await, Some(json!("deny")));
    }

    #[test]
    fn the_summary_is_what_the_tool_would_do() {
        assert_eq!(
            permission_summary("Edit", &json!({"file_path": "/a.ts", "old_string": "x"})),
            "/a.ts"
        );
        assert_eq!(
            permission_summary("WebFetch", &json!({"url": "https://x.y"})),
            "https://x.y"
        );
        assert_eq!(
            permission_summary("Mystery", &json!({"other": 1})),
            "Mystery"
        );
    }

    #[tokio::test]
    async fn claudes_questions_are_answered_with_the_chosen_options() {
        let (_, prompts) = setup();
        let waiting = ask(&prompts, |r| {
            r.tool = "AskUserQuestion".into();
            r.can_always = false;
            r.questions = Some(
                json!([{"question": "Which colors?", "options": [{"label": "Red"}, {"label": "Blue"}], "multiSelect": true}]),
            );
        });
        let id = first_id(&prompts);
        assert_eq!(
            prompts.list("local")[0]["questions"][0]["question"],
            "Which colors?"
        );
        assert!(!prompts.answer("local", &id, json!("allow")));
        let answers = json!({"answers": {"Which colors?": "Red, Blue"}});
        assert!(prompts.answer("local", &id, answers.clone()));
        assert_eq!(waiting.await, Some(answers));
    }

    #[tokio::test]
    async fn in_the_terminal_hands_a_prompt_back_unanswered() {
        let (_, prompts) = setup();
        let waiting = ask(&prompts, |_| {});
        let id = first_id(&prompts);
        assert!(!prompts.release("other", &id));
        assert!(prompts.release("local", &id));
        assert_eq!(waiting.await, None);
    }

    #[tokio::test]
    async fn a_question_or_a_permission_may_be_dismissed_unanswered() {
        for questions in [
            Some(
                json!([{"question": "Which?", "options": [{"label": "A"}], "multiSelect": false}]),
            ),
            None,
        ] {
            let (_, prompts) = setup();
            let has = questions.is_some();
            let waiting = ask(&prompts, |r| {
                if has {
                    r.tool = "AskUserQuestion".into();
                    r.can_always = false;
                }
                r.questions = questions;
            });
            let id = first_id(&prompts);
            assert!(prompts.answer("local", &id, json!("dismiss")));
            assert_eq!(waiting.await, Some(json!("dismiss")));
            assert!(prompts.list("local").is_empty());
        }
    }

    #[tokio::test]
    async fn a_file_edits_prompt_carries_the_change_it_asks_to_make() {
        let (_, prompts) = setup();
        let waiting = ask(&prompts, |r| {
            r.tool = "Edit".into();
            r.input = json!({"file_path": "/w/a.ts", "old_string": "a", "new_string": "b"});
        });
        let prompt = prompts.list("local")[0].clone();
        assert_eq!(prompt["summary"], "/w/a.ts");
        assert_eq!(
            prompt["file_edit"],
            json!({"path": "/w/a.ts", "added": 1, "removed": 1, "hunks": [{"lines": ["-a", "+b"]}]})
        );
        prompts.answer("local", &first_id(&prompts), json!("deny"));
        waiting.await;
        let bash = ask(&prompts, |_| {});
        assert!(prompts.list("local")[0].get("file_edit").is_none());
        prompts.answer("local", &first_id(&prompts), json!("deny"));
        bash.await;
    }
}
