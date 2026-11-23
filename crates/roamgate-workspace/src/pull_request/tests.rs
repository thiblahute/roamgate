//! files.test.ts's PR/MR case, the part after the workspace's root is
//! resolved (the root resolution is the file handlers').

use std::sync::Mutex;

use roamgate_base::clock::SystemClock;
use roamgate_forge::gate::ForgeGate;
use roamgate_forge::mr_cache::MrCache;
use roamgate_git::exec::RunFuture;
use roamgate_git::{GitContext, Invocation, Ran, Request, Runner, shell_quote};

use super::*;
use crate::connection::testing::{FakeHerdr, connection};

const TARGET: &str = "/repo with 'quote/topic";

/// Answers `rev-parse` with /repo, anything else with exit 1.
#[derive(Default)]
struct Host {
    ssh: bool,
    commands: Mutex<Vec<String>>,
}

impl Runner for Host {
    fn run(&self, request: Request) -> RunFuture<'_> {
        Box::pin(async move {
            let command = match &request.invocation {
                Invocation::Ssh { command, .. } => {
                    assert!(self.ssh);
                    command.clone()
                }
                Invocation::Local(argv) => {
                    assert!(!self.ssh);
                    argv.last().unwrap().clone()
                }
            };
            self.commands.lock().unwrap().push(command.clone());
            if command.contains("rev-parse") {
                return Ok(Ran::new(0, "/repo\n", ""));
            }
            // In the worktree asked for.
            assert!(
                command.starts_with(&format!("cd {} &&", shell_quote(TARGET))),
                "{command}"
            );
            Ok(Ran::new(1, "", ""))
        })
    }
}

#[tokio::test]
async fn pr_mr_reads_accept_only_available_worktrees_listed_for_the_source_repository_locally_and_over_ssh()
 {
    for ssh in [false, true] {
        let herdr = FakeHerdr::new(|method, params| {
            assert_eq!(params["workspace_id"], "w1");
            match method {
                "worktree.list" => Ok(json!({
                    "worktrees": [
                        { "path": TARGET },
                        { "path": "/repo/bare", "is_bare": true },
                        { "path": "/repo/gone", "is_prunable": true },
                    ],
                })),
                other => Err(format!("unexpected call {other}")),
            }
        });
        let host = Arc::new(Host {
            ssh,
            ..Host::default()
        });
        let mut conn = connection(herdr);
        conn.git = GitContext::new(ssh.then(|| "user@server".to_owned()), host.clone());
        let clock: roamgate_base::clock::SharedClock = Arc::new(SystemClock);
        let reader = PullRequests::new(clock.clone(), ForgeGate::new(clock.clone()));
        let cache = MrCache::open(clock, None, None);
        let read = |params: Value| {
            let (conn, reader, cache) = (&conn, &reader, &cache);
            async move {
                read_workspace_pull_request(conn, reader, cache, "/repo", &params)
                    .await
                    .unwrap()
            }
        };
        let status =
            read(json!({ "workspace_id": "w1", "worktree_path": TARGET, "summary": true })).await;
        assert_eq!(status["root"], TARGET);
        assert_eq!(status["state"], "detached");
        for worktree_path in [json!("/other/repo"), json!(42)] {
            host.commands.lock().unwrap().clear();
            let result =
                read(json!({ "workspace_id": "w1", "worktree_path": worktree_path })).await;
            assert_eq!(result["state"], "error");
            assert!(
                result["message"]
                    .as_str()
                    .unwrap()
                    .contains("Worktree is unavailable")
            );
            assert!(result.get("retryable").is_none());
            assert!(host.commands.lock().unwrap().is_empty());
        }
        for worktree_path in ["/repo/bare", "/repo/gone"] {
            host.commands.lock().unwrap().clear();
            let result =
                read(json!({ "workspace_id": "w1", "worktree_path": worktree_path })).await;
            assert_eq!(result["state"], "unsupported");
            assert!(
                result["message"]
                    .as_str()
                    .unwrap()
                    .contains("Bare or prunable")
            );
            assert!(host.commands.lock().unwrap().is_empty());
        }
    }
}
