//! `roamgate-review`: talk to Roamgate's reviews (its Changes view), and
//! Claude Code's hooks (permission, questions, claude-start). The same
//! command line, environment, requests, output and exit codes as
//! contract/assets/python/roamgate-review.py, which SSH hosts still run.

use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::argparse::{Exit, Namespace, Nargs, Parser, Sub, Val, opt, pos};
use crate::http::{self, Unreachable};
use crate::py;

/// What Claude is told of a question or request put away in Roamgate.
pub const DISMISSED_QUESTION: &str = "The user dismissed this question without answering.";
pub const DISMISSED_PERMISSION: &str = "The user dismissed this request without answering.";
/// terminal in a claude's environment: it stays in the terminal.
pub const START_ENV: &str = "ROAMGATE_CLAUDE_START";

const DESCRIPTION_HELP: &str = "what this call does, in a few plain words: the user's chat shows it \
     as the call's row, so you do not say it there";

/// Reads an environment variable.
pub type Vars = Box<dyn Fn(&str) -> Option<String>>;

/// The environment and directory the client runs in.
pub struct Env {
    pub vars: Vars,
    pub cwd: String,
}

impl Env {
    /// The process's own.
    pub fn process() -> Self {
        Self {
            vars: Box::new(|name| std::env::var(name).ok()),
            cwd: py::real_cwd(),
        }
    }

    fn var(&self, name: &str) -> String {
        (self.vars)(name).unwrap_or_default()
    }

    fn var_or(&self, name: &str) -> Option<String> {
        (self.vars)(name).filter(|value| !value.is_empty())
    }
}

/// `$ROAMGATE_REVIEW_SOCKET`, else `~/.cache/roamgate/review.sock`.
pub fn socket_path(env: &Env) -> String {
    (env.vars)("ROAMGATE_REVIEW_SOCKET").unwrap_or_else(|| {
        py::home()
            .join(".cache")
            .join("roamgate")
            .join("review.sock")
            .to_string_lossy()
            .into_owned()
    })
}

fn default_agent(env: &Env) -> String {
    env.var_or("ROAMGATE_REVIEW_AGENT").unwrap_or_else(|| {
        if env.var_or("CLAUDECODE").is_some() {
            "Claude".into()
        } else {
            "agent".into()
        }
    })
}

/// `PATH`, or `PATH=BASE..HEAD`: only the path is resolved.
pub fn real_repo(value: &str) -> String {
    if let Some((path, range)) = value.rsplit_once('=')
        && !path.is_empty()
        && range.contains("..")
    {
        return format!("{}={range}", py::realpath(path));
    }
    py::realpath(value)
}

fn real_dir(value: &str) -> String {
    py::realpath(&py::expanduser(value))
}

fn common(parser: &mut Parser, suppress: bool, agent: &str) {
    let session = opt("--session").help("review to use (default: latest here)");
    let agent_option = opt("--agent")
        .help("your name (default: $ROAMGATE_REVIEW_AGENT, Claude in Claude Code, else 'agent')");
    if suppress {
        parser.add(session.suppress());
        parser.add(agent_option.suppress());
    } else {
        parser.add(session);
        parser.add(agent_option.default(Val::Str(agent.to_owned())));
    }
}

fn text_arg(help: &str) -> crate::argparse::Action {
    pos("text").nargs(Nargs::ZeroOrMore).help(help)
}

fn group_args(parser: &mut Parser) {
    parser.add(opt("--group").help(
        "put it in this group of the Workspaces tree instead of under yours: names from the top \
         (or from your own group) such as gst/upstreaming, case-insensitive; see groups",
    ));
    parser.add(
        opt("--create-group")
            .flag()
            .help("make the groups of --group that do not exist"),
    );
}

/// The client's argument parser (`parser()` in the Python client).
pub fn parser(env: &Env) -> Parser {
    let agent = default_agent(env);
    let mut top = Parser::new(
        "roamgate-review",
        Some("Talk to Roamgate's reviews, shown in its Changes view. Output is JSON."),
    );
    common(&mut top, false, &agent);
    let mut subs: Vec<Sub> = vec![];
    let mut sub = |name: &str, help: Option<&str>, build: &dyn Fn(&mut Parser)| {
        let mut parser = Parser::new(&format!("roamgate-review {name}"), None);
        common(&mut parser, true, &agent);
        build(&mut parser);
        subs.push(Sub {
            name: name.to_owned(),
            help: help.map(str::to_owned),
            parser,
        });
    };
    sub("open", Some("open a review in Roamgate"), &|o| {
        o.exclusive(
            false,
            vec![
                opt("--range").help("BASE..HEAD (default: default branch..HEAD)"),
                opt("--worktree").flag().help("uncommitted changes"),
                opt("--last-step")
                    .flag()
                    .help("what your last step changed (the workspace's Last step)"),
                opt("--mr").help("merge request URL"),
                opt("--compare")
                    .nargs(Nargs::Exact(2))
                    .metavar(&["OLD", "NEW"])
                    .help("only what changed from OLD to NEW (tree to tree), e.g. a branch before and after a force-push"),
                opt("--file").help(
                    "a file to discuss as Roamgate renders it (Markdown, HTML, SVG, image)",
                ),
                opt("--url").help("a site's page to browse and discuss in Roamgate"),
            ],
        );
        o.add(opt("--repo").append().help(
            "another repository worked on, PATH or PATH=BASE..HEAD (repeatable); same workspace",
        ));
        o.add(opt("--title"));
        o.add(opt("--message").help("shown when the review opens"));
    });
    sub("skill", Some("print the instructions for agents"), &|_| {});
    sub(
        "list",
        Some("reviews of this checkout (--all: every review here)"),
        &|l| {
            l.add(
                opt("--all")
                    .flag()
                    .help("every review of this connection, whatever the checkout"),
            );
        },
    );
    sub("get", Some("the review with all threads"), &|_| {});
    sub("add", Some("start a thread"), &|a| {
        a.add(opt("--file"));
        a.add(opt("--line").int());
        a.add(opt("--end-line").int());
        a.add(opt("--side").choices(&["old", "new"]));
        a.add(
            opt("--draft")
                .flag()
                .help("a review comment, not a discussion"),
        );
        a.add(
            opt("--quote")
                .help("in a rendered file, or with --on-comment: the words meant, as they read"),
        );
        a.add(opt("--on-comment").help(
            "a comment's id (a work item's description_comment): the thread goes on its part --quote reads",
        ));
        a.add(opt("--description").help(DESCRIPTION_HELP));
        a.add(text_arg("text, or - for standard input"));
    });
    for (name, help) in [
        ("reply", "answer a thread"),
        ("edit", "rewrite one of your comments"),
    ] {
        sub(name, Some(help), &|c| {
            c.add(
                opt("--comment")
                    .required()
                    .help("comment or thread id (prefix ok)"),
            );
            c.add(opt("--description").help(DESCRIPTION_HELP));
            c.add(text_arg("text, or - for standard input"));
        });
    }
    sub("delete", Some("delete one of your comments"), &|d| {
        d.add(opt("--comment").required());
    });
    sub("resolve", Some("resolve a thread"), &|r| {
        r.add(opt("--comment").required());
        r.add(opt("--unresolve").flag());
    });
    sub("reopen", Some("reopen a resolved thread"), &|r| {
        r.add(opt("--comment").required());
    });
    sub(
        "watch",
        Some("wait for threads that need your answer or a handoff"),
        &|w| {
            w.add(opt("--any").flag().help("wake on any change"));
            w.add(
                opt("--timeout")
                    .int()
                    .default(Val::Int(1800))
                    .help("seconds (default 1800)"),
            );
        },
    );
    sub(
        "summary",
        Some("the overall comment: read it (no text), or set it (kept only if the user has none)"),
        &|m| {
            m.add(text_arg("text, or - for standard input; none reads it"));
        },
    );
    sub("working", Some("say you are working on the review"), &|k| {
        k.add(opt("--comment").help("the thread you are working on (comment or thread id)"));
        k.add(opt("--message").help("what you are doing, shown to the user"));
        k.add(opt("--done").flag());
        k.add(opt("--description").help(DESCRIPTION_HELP));
    });
    sub("update", Some("say what changed"), &|u| {
        u.add(opt("--message").required());
    });
    sub(
        "notify",
        Some(
            "tell the user they need to act: a notification, and this agent in their list of what needs them",
        ),
        &|n| {
            n.add(opt("--title").help("a few words (default: your agent and workspace)"));
            n.add(text_arg(
                "what the user needs to do, or - for standard input",
            ));
        },
    );
    sub(
        "place",
        Some(
            "put a workspace under yours in Roamgate's Workspaces list (one you started work in), or in --group",
        ),
        &|p| {
            p.exclusive(
                true,
                vec![
                    opt("--workspace-id").help("its Herdr workspace id"),
                    opt("--path")
                        .map(real_dir)
                        .help("its checkout or directory"),
                ],
            );
            group_args(p);
        },
    );
    sub(
        "worktree",
        Some("create a Git worktree workspace, listed under yours in Roamgate, or in --group"),
        &|w| {
            w.add(opt("--branch").required());
            w.add(
                opt("--repo")
                    .map(real_dir)
                    .help("the repository (default: here)"),
            );
            w.add(opt("--base").help("what to branch from (default: Herdr's)"));
            w.add(opt("--path").help("the checkout's path (default: Herdr's)"));
            w.add(opt("--label").help("the workspace's name"));
            group_args(w);
        },
    );
    sub(
        "workspace",
        Some("create a workspace in a directory, listed under yours in Roamgate, or in --group"),
        &|w| {
            w.add(
                opt("--dir")
                    .map(real_dir)
                    .help("its directory (default: here)"),
            );
            w.add(opt("--label").help("its name"));
            group_args(w);
        },
    );
    sub(
        "groups",
        Some(
            "the groups of Roamgate's Workspaces tree, as paths to give --group, and the one you are in",
        ),
        &|_| {},
    );
    sub(
        "sessions",
        Some(
            "the agent sessions Roamgate manages, on every connection, with the address to message each",
        ),
        &|_| {},
    );
    sub(
        "message",
        Some("send another agent session a message (it is told it comes from you, not its user)"),
        &|m| {
            m.add(pos("to").help("its address, CONNECTION/PANE, as sessions lists it"));
            m.add(text_arg("text, or - for standard input"));
        },
    );
    sub(
        "reviews",
        Some(
            "the Reviews board: your requests' lanes and next steps, overrides, order (TOOL, then its parameters as JSON)",
        ),
        &|r| {
            r.add(pos("tool").help("reviews_list, reviews_override, reviews_order, ..."));
            r.add(
                pos("params")
                    .nargs(Nargs::Optional)
                    .help("a JSON object, or - for standard input"),
            );
        },
    );
    sub(
        "work",
        Some(
            "the Work board: work items by state, tags, owner and links (TOOL, then its parameters as JSON; help lists them)",
        ),
        &|w| {
            w.add(pos("tool").help(
                "work_list, work_add, work_update, work_done, work_reopen, work_adopt, work_project, help",
            ));
            w.add(
                pos("params")
                    .nargs(Nargs::Optional)
                    .help("a JSON object, or - for standard input"),
            );
            w.add(opt("--description").help(DESCRIPTION_HELP));
        },
    );
    sub(
        "permission",
        Some("Claude Code PermissionRequest hook: ask in Roamgate, else the terminal"),
        &|q| {
            q.add(
                opt("--timeout")
                    .int()
                    .default(Val::Int(60))
                    .help("seconds to wait (default 60)"),
            );
        },
    );
    sub(
        "questions",
        Some(
            "Claude Code PreToolUse hook for AskUserQuestion: answer in Roamgate, else the terminal",
        ),
        &|q| {
            q.add(
                opt("--timeout")
                    .int()
                    .default(Val::Int(180))
                    .help("seconds to wait (default 180)"),
            );
        },
    );
    sub(
        "claude-start",
        Some(
            "Claude Code SessionStart hook: conversation mode takes a claude started by hand, if Roamgate is set so",
        ),
        &|_| {},
    );
    top.subcommands("command", subs);
    top
}

/// What a run printed and its exit code.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl From<Exit> for Outcome {
    fn from(exit: Exit) -> Self {
        Self {
            code: exit.code,
            stdout: exit.stdout,
            stderr: exit.stderr,
        }
    }
}

/// How requests reach Roamgate: the socket, or (in tests) a stand-in.
pub trait Transport {
    fn exists(&self, socket: &str) -> bool;
    fn post(
        &self,
        socket: &str,
        command: &str,
        body: &str,
        timeout: Duration,
    ) -> Result<http::Response, Unreachable>;
}

/// The agent socket itself.
pub struct Socket;

impl Transport for Socket {
    fn exists(&self, socket: &str) -> bool {
        // Windows may not stat through a link (or at all) to an AF_UNIX
        // socket, which connects all the same.
        std::fs::metadata(socket).is_ok()
            || (cfg!(windows) && std::fs::symlink_metadata(socket).is_ok())
    }

    fn post(
        &self,
        socket: &str,
        command: &str,
        body: &str,
        timeout: Duration,
    ) -> Result<http::Response, Unreachable> {
        http::post(&PathBuf::from(socket), command, body, timeout)
    }
}

/// Where the client reads its standard input from.
pub type Stdin<'a> = &'a mut dyn FnMut() -> String;

fn fail(message: &str, code: i32) -> Outcome {
    Outcome {
        code,
        stdout: String::new(),
        stderr: format!("{}\n", py::dumps(&json!({"error": message}))),
    }
}

fn text_of(args: &Namespace, stdin: Stdin) -> Option<String> {
    let Some(Val::List(words)) = args.get("text") else {
        return None;
    };
    let words: Vec<&str> = words.iter().filter_map(Val::as_str).collect();
    if words == ["-"] {
        return Some(stdin());
    }
    (!words.is_empty()).then(|| words.join(" "))
}

fn timeout_secs(seconds: i64) -> Duration {
    Duration::from_secs(seconds.max(0) as u64)
}

/// Runs the client with these arguments: what it prints and its code.
pub fn run(args: &[String], env: &Env, transport: &dyn Transport, stdin: Stdin) -> Outcome {
    let width = crate::argparse::help_width((env.vars)("COLUMNS"));
    let parsed = match parser(env).parse_args(args, width) {
        Ok(parsed) => parsed,
        Err(exit) => return exit.into(),
    };
    let command = parsed.str("command").unwrap_or_default().to_owned();
    match command.as_str() {
        "claude-start" => return claude_start(env, transport, stdin),
        "permission" => return permission(&parsed, env, transport, stdin),
        "questions" => return questions(&parsed, env, transport, stdin),
        _ => {}
    }
    let socket = socket_path(env);
    if !transport.exists(&socket) {
        return fail(&format!("Roamgate review socket not found: {socket}"), 2);
    }
    match request(&command, parsed, env, stdin) {
        Ok((body, timeout)) => send(&command, &socket, &body, timeout, transport),
        Err(outcome) => outcome,
    }
}

/// The body sent for a command (what `main()` builds), and its timeout.
pub fn request(
    command: &str,
    mut args: Namespace,
    env: &Env,
    stdin: Stdin,
) -> Result<(Map<String, Value>, Duration), Outcome> {
    // A claude in conversation mode has its pane under Roamgate's names
    // (Herdr's would make Herdr's hook claim the pane).
    let mut body = Map::new();
    body.insert(
        "pane".into(),
        json!(
            env.var_or("HERDR_PANE_ID")
                .unwrap_or_else(|| env.var("ROAMGATE_PANE_ID"))
        ),
    );
    body.insert("workspace".into(), json!(env.var("HERDR_WORKSPACE_ID")));
    body.insert(
        "herdr_socket".into(),
        json!(
            env.var_or("HERDR_SOCKET_PATH")
                .unwrap_or_else(|| env.var("ROAMGATE_HERDR_SOCKET_PATH"))
        ),
    );
    body.insert("cwd".into(), json!(env.cwd));
    body.insert("agent".into(), json!(args.str("agent").unwrap_or_default()));
    if let Some(session) = args.str("session").filter(|s| !s.is_empty()) {
        body.insert("session".into(), json!(session));
    }
    if let Some(Val::List(pair)) = args.get("compare").cloned() {
        let words: Vec<&str> = pair.iter().filter_map(Val::as_str).collect();
        args.set("compare", Val::Str(words.join("..")));
    }
    for (key, value) in &args.0 {
        if matches!(key.as_str(), "session" | "agent" | "command" | "text")
            || value.is_none_or_false()
        {
            continue;
        }
        let value = match value {
            Val::List(items) => json!(
                items
                    .iter()
                    .filter_map(Val::as_str)
                    .map(real_repo)
                    .collect::<Vec<_>>()
                    .join("\n")
            ),
            Val::Bool(true) => json!("1"),
            Val::Int(int) => json!(int),
            Val::Str(text) => json!(text),
            Val::Bool(false) | Val::None => continue,
        };
        body.insert(key.replace('-', "_"), value);
    }
    if matches!(command, "reviews" | "work") && args.str("params") == Some("-") {
        body.insert("params".into(), json!(stdin()));
    }
    if args.has("text")
        && let Some(text) = text_of(&args, stdin)
    {
        body.insert("text".into(), json!(text));
    }
    let mut timeout = timeout_secs(60);
    if command == "watch" {
        body.insert(
            "mode".into(),
            json!(if args.flag("any") {
                "any"
            } else {
                "unanswered"
            }),
        );
        body.shift_remove("any");
        timeout = timeout_secs(args.int("timeout").unwrap_or(1800) + 30);
    }
    Ok((body, timeout))
}

fn send(
    command: &str,
    socket: &str,
    body: &Map<String, Value>,
    timeout: Duration,
    transport: &dyn Transport,
) -> Outcome {
    let text = py::dumps(&Value::Object(body.clone()));
    let response = match transport.post(socket, command, &text, timeout) {
        Ok(response) => response,
        Err(error) => return fail(&format!("cannot reach Roamgate: {error}"), 1),
    };
    let data = response.text();
    if response.status >= 400 {
        return Outcome {
            code: 1,
            stdout: String::new(),
            stderr: format!("{data}\n"),
        };
    }
    if command == "skill" {
        let skill = serde_json::from_str::<Value>(&data)
            .ok()
            .and_then(|value| {
                value
                    .get("skill")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default();
        return Outcome {
            code: 0,
            stdout: skill,
            stderr: String::new(),
        };
    }
    Outcome {
        code: 0,
        stdout: format!("{data}\n"),
        stderr: String::new(),
    }
}

/// Roamgate's conversation mode runs this claude and asks the user itself
/// (over stdio): its hooks must not ask a second time.
fn headless(env: &Env) -> bool {
    env.var("ROAMGATE_HEADLESS") == "1"
}

fn read_hook(stdin: Stdin) -> Option<Value> {
    serde_json::from_str(&stdin()).ok()
}

fn printed(value: Value) -> Outcome {
    Outcome {
        code: 0,
        stdout: format!("{}\n", py::dumps(&value)),
        stderr: String::new(),
    }
}

fn hook_body(env: &Env, agent: &str) -> Map<String, Value> {
    let mut body = Map::new();
    body.insert("pane".into(), json!(env.var("HERDR_PANE_ID")));
    body.insert("workspace".into(), json!(env.var("HERDR_WORKSPACE_ID")));
    body.insert("herdr_socket".into(), json!(env.var("HERDR_SOCKET_PATH")));
    body.insert("cwd".into(), json!(env.cwd));
    body.insert("agent".into(), json!(agent));
    body
}

/// A hook's request to Roamgate: its reply, or None on any failure.
fn ask(
    args: &Namespace,
    env: &Env,
    transport: &dyn Transport,
    command: &str,
    extra: Map<String, Value>,
) -> Option<Value> {
    let socket = socket_path(env);
    if env.var("HERDR_PANE_ID").is_empty() || !transport.exists(&socket) {
        return None;
    }
    let timeout = args.int("timeout").unwrap_or(0);
    let mut body = hook_body(env, args.str("agent").unwrap_or_default());
    body.insert("timeout".into(), json!(timeout.to_string()));
    body.extend(extra);
    let text = py::dumps(&Value::Object(body));
    let response = transport
        .post(&socket, command, &text, timeout_secs(timeout + 30))
        .ok()?;
    serde_json::from_str(&response.text()).ok()
}

/// A PreToolUse hook on AskUserQuestion: Claude Code shows its own
/// questions only if this prints nothing.
fn questions(args: &Namespace, env: &Env, transport: &dyn Transport, stdin: Stdin) -> Outcome {
    if headless(env) {
        return Outcome::default();
    }
    let Some(hook) = read_hook(stdin) else {
        return Outcome::default();
    };
    let tool_input = hook
        .get("tool_input")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let asked = tool_input
        .get("questions")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| json!([]));
    if !truthy(&asked) {
        return Outcome::default();
    }
    let mut extra = Map::new();
    extra.insert("questions".into(), json!(py::dumps(&asked)));
    let reply = ask(args, env, transport, "questions", extra).unwrap_or(Value::Null);
    if reply.get("dismissed").is_some_and(truthy) {
        // Put away unanswered in Roamgate: Claude is told so and goes on.
        return printed(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": DISMISSED_QUESTION,
            }
        }));
    }
    let Some(answers) = reply.get("answers").filter(|value| truthy(value)) else {
        return Outcome::default();
    };
    let mut updated = tool_input.as_object().cloned().unwrap_or_default();
    updated.insert("answers".into(), answers.clone());
    printed(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "updatedInput": updated,
        }
    }))
}

/// Python's truth of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// A PermissionRequest hook: Claude Code waits on it before its own
/// dialog. Any failure, or no answer in time, prints nothing: the
/// terminal asks as usual.
fn permission(args: &Namespace, env: &Env, transport: &dyn Transport, stdin: Stdin) -> Outcome {
    if headless(env) {
        return Outcome::default();
    }
    let socket = socket_path(env);
    if env.var("HERDR_PANE_ID").is_empty() || !transport.exists(&socket) {
        return Outcome::default();
    }
    let Some(hook) = read_hook(stdin) else {
        return Outcome::default();
    };
    // Claude's questions have their own hook (questions); a permission card
    // could only allow them unanswered.
    if hook.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion") {
        return Outcome::default();
    }
    let suggestions = hook
        .get("permission_suggestions")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| json!([]));
    let timeout = args.int("timeout").unwrap_or(0);
    let mut body = hook_body(env, args.str("agent").unwrap_or_default());
    let tool = hook
        .get("tool_name")
        .filter(|value| truthy(value))
        .cloned()
        .unwrap_or_else(|| json!("tool"));
    body.insert("tool".into(), tool);
    body.insert(
        "input".into(),
        json!(py::dumps(hook.get("tool_input").unwrap_or(&Value::Null))),
    );
    body.insert(
        "can_always".into(),
        json!(if truthy(&suggestions) { "1" } else { "" }),
    );
    body.insert("timeout".into(), json!(timeout.to_string()));
    let text = py::dumps(&Value::Object(body));
    let Ok(response) = transport.post(&socket, "permission", &text, timeout_secs(timeout + 30))
    else {
        return Outcome::default();
    };
    let Ok(reply) = serde_json::from_str::<Value>(&response.text()) else {
        return Outcome::default();
    };
    // Python's .get on a non-dict reply fails: nothing printed then.
    let Some(reply) = reply.as_object() else {
        return Outcome {
            code: 1,
            stdout: String::new(),
            stderr: String::new(),
        };
    };
    let decision = match reply.get("answer").and_then(Value::as_str) {
        Some("deny") => json!({"behavior": "deny", "message": "Denied from Roamgate"}),
        Some("dismiss") => json!({"behavior": "deny", "message": DISMISSED_PERMISSION}),
        Some("always") => json!({"behavior": "allow", "updatedPermissions": suggestions}),
        Some("allow") => json!({"behavior": "allow"}),
        _ => return Outcome::default(),
    };
    printed(json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    }))
}

/// The interactive claude this hook runs for: the nearest ancestor that
/// is claude (the hook runs under a shell). None if none is found.
fn claude_process() -> Option<(u32, Vec<String>)> {
    let mut pid = parent_pid()?;
    for _ in 0..6 {
        if pid <= 1 {
            return None;
        }
        let out = ps_line(pid)?;
        let mut parts = out.trim().splitn(2, char::is_whitespace);
        let parent = parts.next()?.to_owned();
        let rest = parts.next()?.trim_start();
        let argv: Vec<String> = rest.split_whitespace().map(str::to_owned).collect();
        let names: Vec<&str> = argv
            .iter()
            .take(2)
            .map(|word| word.rsplit('/').next().unwrap_or(word))
            .collect();
        if names.contains(&"claude")
            || argv
                .iter()
                .take(2)
                .any(|word| word.ends_with("claude-code/cli.js"))
        {
            return Some((pid, argv));
        }
        pid = parent.parse().ok()?;
    }
    None
}

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    rustix::process::getppid().map(|pid| pid.as_raw_nonzero().get() as u32)
}

#[cfg(not(unix))]
fn parent_pid() -> Option<u32> {
    None
}

/// `ps -o ppid= -o args= -p PID`, within 3 seconds.
fn ps_line(pid: u32) -> Option<String> {
    let output = crate::process::output_within(
        std::process::Command::new("ps").args([
            "-o",
            "ppid=",
            "-o",
            "args=",
            "-p",
            &pid.to_string(),
        ]),
        Duration::from_secs(3),
    )?;
    Some(String::from_utf8_lossy(&output).into_owned())
}

/// A SessionStart hook: prints nothing (it would reach Claude's context),
/// waits on nothing (Claude starts meanwhile). Roamgate decides, by its
/// claude start setting, and takes the session once Claude is up.
fn claude_start(env: &Env, transport: &dyn Transport, stdin: Stdin) -> Outcome {
    if headless(env) {
        return Outcome::default();
    }
    let start = env.var(START_ENV).trim().to_lowercase();
    if ["terminal", "tui", "0", "off", "no"].contains(&start.as_str()) {
        return Outcome::default();
    }
    let socket = socket_path(env);
    if env.var("HERDR_PANE_ID").is_empty() || !transport.exists(&socket) {
        return Outcome::default();
    }
    let Some(hook) = read_hook(stdin) else {
        return Outcome::default();
    };
    let Some(hook) = hook.as_object() else {
        return Outcome::default();
    };
    let event = hook
        .get("hook_event_name")
        .cloned()
        .unwrap_or_else(|| json!("SessionStart"));
    if event != json!("SessionStart") {
        return Outcome::default();
    }
    // Only a claude started, or resumed, by hand: not /clear, not compact.
    let text = |name: &str| {
        hook.get(name)
            .filter(|value| truthy(value))
            .cloned()
            .unwrap_or_else(|| json!(""))
    };
    let source = text("source");
    let session = text("session_id");
    if !matches!(source.as_str(), Some("startup" | "resume"))
        || !truthy(&session)
        || hook.get("agent_id").is_some_and(truthy)
    {
        return Outcome::default();
    }
    let Some((pid, argv)) = claude_process() else {
        return Outcome::default();
    };
    // claude -p in a pane prints and ends: nothing to take.
    if argv.iter().any(|word| word == "-p" || word == "--print") {
        return Outcome::default();
    }
    let cwd = match hook
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
    {
        Some(cwd) => py::realpath(cwd),
        None => env.cwd.clone(),
    };
    let mut body = Map::new();
    body.insert("pane".into(), json!(env.var("HERDR_PANE_ID")));
    body.insert("workspace".into(), json!(env.var("HERDR_WORKSPACE_ID")));
    body.insert("herdr_socket".into(), json!(env.var("HERDR_SOCKET_PATH")));
    body.insert("cwd".into(), json!(cwd));
    body.insert("session".into(), session);
    body.insert("source".into(), source);
    body.insert("pid".into(), json!(pid.to_string()));
    let text = py::dumps(&Value::Object(body));
    let _ = transport.post(&socket, "claude_start", &text, Duration::from_secs(3));
    Outcome::default()
}

/// `roamgate-review ARGS`, as the process: prints, and gives the code.
pub fn main(args: &[String]) -> i32 {
    let env = Env::process();
    let mut stdin = || {
        let mut text = String::new();
        let mut bytes = vec![];
        if std::io::stdin().read_to_end(&mut bytes).is_ok() {
            text = String::from_utf8_lossy(&bytes).into_owned();
        }
        text
    };
    let outcome = run(args, &env, &Socket, &mut stdin);
    crate::process::print(&outcome.stdout, &outcome.stderr);
    outcome.code
}
