//! `contract/vectors/driver-contract.json` (`drivers/contract.test.ts`):
//! the drivers' contract, replayed on the Rust drivers.

use std::collections::HashMap;

use roamgate_agents::js;
use roamgate_conversation::driver::{
    ApiKeyAnswer, ConversationDriver, DriverCodec, DriverImage, DriverMessage, PaneProcess,
    StartOptions, StartProfile,
};
use roamgate_protocol::vectors::{self, Call};
use serde_json::{Map, Value, json};

use super::{claude_driver, drivers};

enum Handle {
    Protocol(ConversationDriver),
    Terminal(ConversationDriver),
    Memory,
    Rewind,
    Models,
    Mcp,
    Codec(Box<dyn DriverCodec>),
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn start_options(value: &Value) -> StartOptions {
    StartOptions {
        session_id: text(value.get("sessionId")).unwrap_or_default(),
        pane_id: text(value.get("paneId")),
        cwd: text(value.get("cwd")).unwrap_or_default(),
        flags: value.get("flags").map(strings),
        api_key_answer: value
            .get("apiKeyAnswer")
            .and_then(Value::as_str)
            .and_then(ApiKeyAnswer::parse),
        profile: value.get("profile").map(|profile| StartProfile {
            program: text(profile.get("program")).unwrap_or_default(),
            env: profile
                .get("env")
                .and_then(Value::as_object)
                .map(|env| {
                    env.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            unset: profile.get("unset").map(strings).unwrap_or_default(),
        }),
    }
}

fn message(value: &Value) -> DriverMessage {
    DriverMessage {
        text: text(value.get("text")).unwrap_or_default(),
        images: value
            .get("images")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|image| DriverImage {
                path: text(image.get("path")).unwrap_or_default(),
                media_type: text(image.get("media_type")),
                data: text(image.get("data")),
            })
            .collect(),
        uuid: text(value.get("uuid")).unwrap_or_default(),
        prelude: value.get("prelude").map(strings).unwrap_or_default(),
        steer: js::is_true(value.get("steer")),
    }
}

fn pane_process(value: &Value) -> PaneProcess {
    PaneProcess {
        pid: value.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
        argv: value.get("argv").map(strings),
        argv0: text(value.get("argv0")),
        cmdline: text(value.get("cmdline")),
        cwd: text(value.get("cwd")),
    }
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn undefined() -> Value {
    json!({"$undefined": true})
}

struct Runner {
    handles: HashMap<u64, Handle>,
}

impl Runner {
    /// Binds the handles a call's recorded result names to what it gave.
    fn bind(&mut self, want: Option<&Value>, got: Vec<(&str, Handle)>) {
        let Some(want) = want else {
            return;
        };
        let mut got: HashMap<&str, Handle> = got.into_iter().collect();
        let mut bind_one = |pattern: &Value, key: &str| {
            if let Some(("$handle", id)) = vectors::tag(pattern)
                && let Some(handle) = got.remove(key)
            {
                self.handles
                    .insert(id.as_u64().expect("a handle id"), handle);
            }
        };
        match want {
            Value::Array(items) => {
                if let Some(Value::Object(first)) = items.first() {
                    for (key, pattern) in first {
                        bind_one(pattern, key);
                    }
                }
            }
            Value::Object(fields) if vectors::tag(want).is_none() => {
                for (key, pattern) in fields {
                    bind_one(pattern, key);
                }
            }
            _ => bind_one(want, ""),
        }
    }

    fn driver_handles(driver: &ConversationDriver) -> Vec<(&'static str, Handle)> {
        vec![
            ("protocol", Handle::Protocol(driver.clone())),
            ("terminal", Handle::Terminal(driver.clone())),
            ("memory", Handle::Memory),
        ]
    }

    /// What the call gave, for comparing; None when no port knows it.
    fn run(&mut self, call: &Call) -> Option<Value> {
        let args = &call.args;
        let arg = |n: usize| args.get(n).cloned().unwrap_or(Value::Null);
        if let Some(name) = &call.fn_ {
            let all = drivers();
            let driver = match name.as_str() {
                "drivers.conversationDrivers" => {
                    assert_eq!(all.all().len(), 1, "one driver");
                    Some(all.all()[0].clone())
                }
                "drivers.conversationDriver" => Some(all.of(arg(0).as_str()).clone()),
                "drivers.driverForHerdrAgent" => arg(0)
                    .as_str()
                    .and_then(|name| all.for_herdr_agent(name))
                    .cloned(),
                _ => return None,
            };
            let handles = driver
                .as_ref()
                .map(Self::driver_handles)
                .unwrap_or_default();
            self.bind(call.result.as_ref(), handles);
            return Some(call.result.clone().unwrap_or(Value::Null));
        }
        let id = call.on?;
        let member = call.method.as_deref().or(call.get.as_deref())?;
        // Members that give a handle of their own.
        if let Some(Handle::Protocol(driver)) = self.handles.get(&id) {
            let made = match member {
                "rewind" => driver.protocol.rewind().map(|_| Handle::Rewind),
                "models" => driver.protocol.models().map(|_| Handle::Models),
                "mcp" => driver.protocol.mcp().map(|_| Handle::Mcp),
                "createCodec" => Some(Handle::Codec(driver.protocol.create_codec())),
                _ => None,
            };
            if let Some(made) = made {
                let result = call.result.clone();
                self.bind(result.as_ref(), vec![("", made)]);
                return result;
            }
        }
        let handle = self.handles.get_mut(&id)?;
        let given = match (handle, member) {
            (Handle::Protocol(driver), "agent") => json!(driver.protocol.agent()),
            (Handle::Protocol(driver), "displayName") => json!(driver.protocol.display_name()),
            (Handle::Protocol(driver), "capabilities") => driver.protocol.capabilities(),
            (Handle::Protocol(driver), "answerKind") => json!(driver.protocol.answer_kind()),
            (Handle::Protocol(driver), "startCommand") => {
                Value::Object(driver.protocol.start_command(&start_options(&arg(0))))
            }
            (Handle::Protocol(driver), "promptOf") => {
                let prompt = driver.protocol.prompt_of(&object(&arg(0)));
                let mut result = Map::new();
                result.insert("tool".into(), json!(prompt.tool));
                result.insert("input".into(), prompt.input);
                result.insert("canAlways".into(), json!(prompt.can_always));
                if let Some(questions) = prompt.questions {
                    result.insert("questions".into(), Value::Array(questions));
                }
                Value::Object(result)
            }
            (Handle::Protocol(driver), "inputKind") => {
                let kind = driver.protocol.input_kind(arg(0).as_str().unwrap_or(""));
                let mut result = Map::new();
                result.insert("kind".into(), json!(kind.kind));
                if let Some(id) = kind.request_id {
                    result.insert("request_id".into(), json!(id));
                }
                Value::Object(result)
            }
            (Handle::Protocol(driver), "parseWrittenMessage") => {
                match driver
                    .protocol
                    .parse_written_message(arg(0).as_str().unwrap_or(""))
                {
                    None => Value::Null,
                    Some(written) => {
                        let mut result = Map::new();
                        if let Some(uuid) = written.uuid {
                            result.insert("uuid".into(), json!(uuid));
                        }
                        result.insert("text".into(), json!(written.text));
                        Value::Object(result)
                    }
                }
            }
            (Handle::Terminal(driver), "agent") => json!(driver.terminal.agent()),
            (Handle::Terminal(driver), "herdrAgent") => json!(driver.terminal.herdr_agent()),
            (Handle::Terminal(driver), "exitCommand") => json!(driver.terminal.exit_command()),
            (Handle::Terminal(driver), "resumeArgv") => json!(
                driver
                    .terminal
                    .resume_argv(arg(0).as_str().unwrap_or(""), &strings(&arg(1)))
            ),
            (Handle::Terminal(driver), "isAgentProcess") => {
                json!(driver.terminal.is_agent_process(&pane_process(&arg(0))))
            }
            (Handle::Terminal(driver), "headlessProbe") => json!(
                driver
                    .terminal
                    .headless_probe(arg(0).as_str().unwrap_or(""), &strings(&arg(1)))
            ),
            (Handle::Terminal(driver), "interactiveWriter") => {
                let except: Vec<u32> = arg(2)
                    .as_array()
                    .map(|pids| {
                        pids.iter()
                            .filter_map(Value::as_u64)
                            .map(|p| p as u32)
                            .collect()
                    })
                    .unwrap_or_default();
                json!(driver.terminal.interactive_writer(
                    arg(0).as_str().unwrap_or(""),
                    &strings(&arg(1)),
                    &except
                ))
            }
            (Handle::Terminal(driver), "readiness") => {
                let ready = driver.terminal.readiness(arg(0).as_str().unwrap_or(""));
                json!({
                    "background": ready.background,
                    "backgroundKnown": ready.background_known,
                    "refusal": ready.refusal,
                })
            }
            (Handle::Codec(codec), "line") => Value::Array(
                codec
                    .line(arg(0).as_str().unwrap_or(""))
                    .into_iter()
                    .map(Value::Object)
                    .collect(),
            ),
            (Handle::Codec(codec), "save") => codec.save(),
            (Handle::Codec(codec), "restore") => {
                codec.restore(&arg(0));
                undefined()
            }
            (Handle::Codec(codec), "message") => json!(codec.message(&message(&arg(0)))),
            (Handle::Codec(codec), "interrupt") => {
                json!(codec.interrupt(arg(0).as_str().unwrap_or("")))
            }
            (Handle::Codec(codec), "answer") => {
                let answer = arg(1);
                json!(codec.answer(&object(&arg(0)), Some(&answer)))
            }
            (Handle::Codec(codec), "request") => json!(codec.request(
                arg(0).as_str().unwrap_or(""),
                &object(&arg(1)),
                arg(2).as_str().unwrap_or("")
            )),
            (Handle::Memory | Handle::Rewind | Handle::Models | Handle::Mcp, _) => return None,
            _ => return None,
        };
        Some(given)
    }
}

#[test]
fn driver_contract_vectors() {
    let file = vectors::load("driver-contract");
    let mut ran = 0;
    let mut failures = Vec::new();
    for case in &file.cases {
        let mut runner = Runner {
            handles: HashMap::new(),
        };
        for call in &case.calls {
            let target = call.target();
            let Some(got) = runner.run(call) else {
                panic!(
                    "driver-contract: {}: no Rust port of {target}",
                    case.title()
                );
            };
            // A recorded null reads as no result (`Option<Value>`): either.
            let want = call.result.clone().unwrap_or_else(undefined);
            let same = got == want || (call.result.is_none() && got.is_null());
            if !same {
                failures.push(format!(
                    "{} > {target}\n  got:  {}\n  want: {}",
                    case.title(),
                    js::stringify(&got),
                    js::stringify(&want)
                ));
            }
            ran += 1;
        }
    }
    assert!(ran > 0, "no call replayed");
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn claude_is_the_default_driver() {
    let all = drivers();
    assert_eq!(all.of(None).protocol.agent(), "claude");
    assert_eq!(all.of(Some("other")).terminal.herdr_agent(), "claude");
    assert!(all.for_herdr_agent("codex").is_none());
    assert_eq!(claude_driver().protocol.display_name(), "Claude");
}
