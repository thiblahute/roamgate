//! server/src/review/review-base.test.ts: which review the branch's three
//! ways in land on (the agent's `open` with no target, Option+R and a
//! comment in Changes' Branch scope), against a real repository. The
//! default base and Changes' Branch scope base are read with the loaders
//! the TS suite uses (review-patch.ts's readDefaultBase, diff-base.ts's
//! resolveDefaultBase); the review service is opened as the agent socket
//! (agent-server.ts) and rpc.ts open it with what they read.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::model::ReviewSnapshot;

/// A clone whose default branch is main (origin/HEAD set), a local main,
/// a branch `other`, and `topic` checked out with a commit of its own.
struct Repository {
    _dirs: (tempfile::TempDir, tempfile::TempDir),
    root: PathBuf,
    upstream: PathBuf,
}

fn temp(prefix: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in("/tmp")
        .unwrap();
    let path = dir.path().canonicalize().unwrap();
    (dir, path)
}

fn repository() -> Repository {
    let (up_dir, upstream) = temp("rg-up-");
    git(&upstream, &["init", "-q", "-b", "main"]);
    git(&upstream, &["commit", "-q", "--allow-empty", "-m", "first"]);
    git(&upstream, &["branch", "other"]);
    let (clone_dir, clones) = temp("rg-clone-");
    let root = clones.join("repo");
    git(
        Path::new("/tmp"),
        &[
            "clone",
            "-q",
            upstream.to_str().unwrap(),
            root.to_str().unwrap(),
        ],
    );
    git(&root, &["branch", "other", "origin/other"]);
    git(&root, &["checkout", "-q", "-b", "topic"]);
    git(
        &root,
        &["commit", "-q", "--allow-empty", "-m", "topic work"],
    );
    Repository {
        _dirs: (up_dir, clone_dir),
        root,
        upstream,
    }
}

/// A remote whose HEAD names Entire's metadata branch.
fn entire_repository() -> Repository {
    let repository = repository();
    let upstream = &repository.upstream;
    git(
        upstream,
        &["checkout", "-q", "--orphan", "entire/checkpoints/v1"],
    );
    git(
        upstream,
        &[
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "Initialize metadata branch",
        ],
    );
    git(upstream, &["checkout", "-q", "main"]);
    git(&repository.root, &["fetch", "-q"]);
    git(
        &repository.root,
        &["remote", "set-head", "origin", "entire/checkpoints/v1"],
    );
    repository
}

struct Ways {
    kit: Kit,
    bun: PathBuf,
    root: String,
}

impl Ways {
    fn new(bun: PathBuf, root: &Path) -> Self {
        let host = Host {
            heads: git_host(&bun).heads,
            ..Host::default()
        };
        Self {
            kit: kit(host, Options::default()),
            bun,
            root: root.to_string_lossy().into_owned(),
        }
    }

    fn service(&self) -> &ReviewService {
        &self.kit.service
    }

    async fn default_base(&self) -> Option<String> {
        load_with(&self.bun, "defaultBase", json!({"root": self.root}))
            .await
            .ok()
            .and_then(|base| base.as_str().map(str::to_owned))
    }

    /// Changes' Branch scope base under Automatic.
    async fn branch_scope_base(&self) -> Value {
        load_with(&self.bun, "branchBase", json!({"root": self.root}))
            .await
            .unwrap()
    }

    /// The agent's `review_open` (agent-server.ts): no target flag is the
    /// default base, automatic; `--range` is a range the user may already
    /// review under another name.
    async fn agent_open(&self, range: Option<(&str, &str)>) -> ReviewSnapshot {
        let service = self.service();
        let (target, automatic) = match range {
            None => (
                json!({"kind": "range", "base": self.default_base().await.unwrap(), "head": "HEAD"}),
                true,
            ),
            Some((base, head)) => {
                let target = crate::parse::parse_review_target(Some(
                    &json!({"kind": "range", "base": base, "head": head}),
                ))
                .unwrap();
                (
                    service
                        .equivalent_target("local", &self.root, target)
                        .await
                        .to_value(),
                    false,
                )
            }
        };
        service
            .open(
                &json!({"connectionId": "local", "root": self.root, "target": target,
                "automatic": automatic, "paneId": "w1:p2", "agent": "Claude", "workspaceId": "w1"}),
            )
            .unwrap()
    }

    /// rpc.ts's `review.open`: no target is the branch against the default
    /// branch, automatic.
    async fn rpc_open(&self, target: Option<Value>, agent: bool) -> ReviewSnapshot {
        let mut params = json!({"connectionId": "local", "workspaceId": "w1", "root": self.root, "raise": false});
        if agent {
            params["agent"] = json!("Claude");
            params["paneId"] = json!("w1:p2");
        }
        match target {
            Some(target) => params["target"] = target,
            None => match self.default_base().await {
                Some(base) => {
                    params["target"] = json!({"kind": "range", "base": base, "head": "HEAD"});
                    params["automatic"] = json!(true);
                }
                None => params["target"] = json!({"kind": "worktree"}),
            },
        }
        self.service().open(&params).unwrap()
    }

    /// Option+R: the workspace's review, no target.
    async fn option_r(&self) -> ReviewSnapshot {
        self.rpc_open(None, true).await
    }

    /// A comment in Changes' Branch scope: the checkout opened with no
    /// target (or the picked base's range), then the thread added there.
    async fn branch_comment(&self, text: &str, picked: Option<&str>) -> ReviewSnapshot {
        let opened = self
            .rpc_open(
                picked.map(|base| json!({"kind": "range", "base": base, "head": "HEAD"})),
                false,
            )
            .await;
        self.service()
            .add_thread(&json!({"sessionId": opened.session.id,
                "anchor": {"path": "a.ts", "line": 1, "side": "new", "feedback": "diff"}, "text": text}))
            .await
            .unwrap();
        opened
    }

    fn target_of(&self, id: &str) -> Value {
        self.service()
            .get(&json!({"sessionId": id}))
            .unwrap()
            .session
            .target
            .to_value()
    }

    fn bodies(&self, id: &str) -> Vec<String> {
        ids(
            &self
                .service()
                .get(&json!({"sessionId": id}))
                .unwrap()
                .threads,
            |t| t.comments[0].body.clone(),
        )
    }

    fn reviews(&self) -> usize {
        self.service().list(&json!({"root": self.root})).len()
    }
}

fn range(base: &str) -> Value {
    json!({"kind": "range", "base": base, "head": "HEAD"})
}

#[tokio::test]
async fn review_open_with_no_target_option_r_and_a_branch_scope_comment_land_on_the_same_review() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let ways = Ways::new(bun, &repository.root);
    let by_agent = ways.agent_open(None).await;
    let by_key = ways.option_r().await;
    let by_comment = ways.branch_comment("Why?", None).await;
    assert_eq!(
        crate::parse::describe_target(&by_agent.session.target),
        "origin/main..HEAD"
    );
    assert_eq!(ways.target_of(&by_agent.session.id), range("origin/main"));
    assert_eq!(by_key.session.id, by_agent.session.id);
    assert_eq!(by_comment.session.id, by_agent.session.id);
    assert_eq!(ways.bodies(&by_agent.session.id), vec!["Why?"]);
    assert_eq!(
        ways.branch_scope_base().await,
        json!("refs/remotes/origin/main")
    );
}

#[tokio::test]
async fn a_comment_under_a_picked_compare_against_base_lands_in_that_bases_review() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let ways = Ways::new(bun, &repository.root);
    let picked = ways.agent_open(Some(("other", "HEAD"))).await;
    assert_eq!(
        crate::parse::describe_target(&picked.session.target),
        "other..HEAD"
    );
    let by_comment = ways
        .branch_comment("On the picked base", Some("other"))
        .await;
    assert_eq!(by_comment.session.id, picked.session.id);
    assert_eq!(ways.bodies(&picked.session.id), vec!["On the picked base"]);
    let by_key = ways.option_r().await;
    assert_ne!(by_key.session.id, picked.session.id);
    assert_eq!(by_key.session.target.to_value(), range("origin/main"));
    assert!(ways.bodies(&by_key.session.id).is_empty());
}

#[tokio::test]
async fn a_stale_local_main_changes_and_the_review_both_compare_with_origin_main() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let root = &repository.root;
    git(
        &repository.upstream,
        &["commit", "-q", "--allow-empty", "-m", "upstream moves on"],
    );
    git(root, &["fetch", "-q"]);
    git(root, &["rebase", "-q", "origin/main"]);
    assert_eq!(
        git(root, &["rev-list", "--count", "main..origin/main"]),
        "1"
    );
    let ways = Ways::new(bun, root);
    assert_eq!(
        ways.branch_scope_base().await,
        json!("refs/remotes/origin/main")
    );
    assert_eq!(
        ways.option_r().await.session.target.to_value(),
        range("origin/main")
    );
}

#[tokio::test]
async fn a_local_main_ahead_of_origin_main_changes_and_the_review_both_compare_with_main() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let root = &repository.root;
    git(root, &["checkout", "-q", "main"]);
    git(
        root,
        &["commit", "-q", "--allow-empty", "-m", "not pushed yet"],
    );
    git(root, &["checkout", "-q", "topic"]);
    git(root, &["rebase", "-q", "main"]);
    let ways = Ways::new(bun, root);
    assert_eq!(ways.branch_scope_base().await, json!("refs/heads/main"));
    assert_eq!(
        ways.option_r().await.session.target.to_value(),
        range("main")
    );
    git(root, &["checkout", "-q", "main"]);
    assert_eq!(
        ways.branch_scope_base().await,
        json!("refs/remotes/origin/main")
    );
}

#[tokio::test]
async fn local_main_and_origin_main_diverged_the_one_whose_merge_base_with_head_is_newest() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let root = &repository.root;
    git(
        &repository.upstream,
        &["commit", "-q", "--allow-empty", "-m", "upstream moves on"],
    );
    git(root, &["fetch", "-q"]);
    git(root, &["checkout", "-q", "main"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", "local only"]);
    git(
        root,
        &["checkout", "-q", "-b", "from-remote", "origin/main"],
    );
    git(root, &["commit", "-q", "--allow-empty", "-m", "work"]);
    let ways = Ways::new(bun, root);
    assert_eq!(
        ways.branch_scope_base().await,
        json!("refs/remotes/origin/main")
    );
    git(root, &["checkout", "-q", "-b", "from-local", "main"]);
    git(root, &["commit", "-q", "--allow-empty", "-m", "work"]);
    assert_eq!(ways.branch_scope_base().await, json!("refs/heads/main"));
}

#[tokio::test]
async fn when_automatics_base_moves_the_branchs_review_follows_it_with_its_comments() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let root = &repository.root;
    let ways = Ways::new(bun, root);
    let before = ways.branch_comment("Kept?", None).await;
    assert_eq!(before.session.target.to_value(), range("origin/main"));
    git(root, &["checkout", "-q", "main"]);
    git(
        root,
        &["commit", "-q", "--allow-empty", "-m", "not pushed yet"],
    );
    git(root, &["checkout", "-q", "topic"]);
    git(root, &["rebase", "-q", "main"]);
    let after = ways.option_r().await;
    assert_eq!(after.session.id, before.session.id);
    let now = ways
        .service()
        .get(&json!({"sessionId": after.session.id}))
        .unwrap();
    assert_eq!(now.session.target.to_value(), range("main"));
    assert_eq!(now.session.title, "main..HEAD");
    assert_eq!(ways.bodies(&after.session.id), vec!["Kept?"]);
    assert_eq!(ways.reviews(), 1);
}

#[tokio::test]
async fn a_remote_head_naming_entires_checkpoints_is_no_base_the_default_branch_is() {
    let Some(bun) = bun() else { return };
    let repository = entire_repository();
    let root = &repository.root;
    assert_eq!(
        git(root, &["symbolic-ref", "refs/remotes/origin/HEAD"]),
        "refs/remotes/origin/entire/checkpoints/v1"
    );
    let ways = Ways::new(bun, root);
    assert_eq!(
        ways.branch_scope_base().await,
        json!("refs/remotes/origin/main")
    );
    assert_eq!(
        ways.option_r().await.session.target.to_value(),
        range("origin/main")
    );
    assert_eq!(
        crate::parse::describe_target(&ways.agent_open(None).await.session.target),
        "origin/main..HEAD"
    );
}

#[tokio::test]
async fn a_branchs_review_once_based_on_a_metadata_ref_follows_automatic_to_the_default_branch() {
    let Some(bun) = bun() else { return };
    let repository = entire_repository();
    let ways = Ways::new(bun, &repository.root);
    let before = ways
        .service()
        .open(
            &json!({"connectionId": "local", "workspaceId": "w1", "root": ways.root,
            "target": range("origin/entire/checkpoints/v1"), "automatic": true}),
        )
        .unwrap();
    ways.service()
        .add_thread(&json!({"sessionId": before.session.id,
            "anchor": {"path": "a.ts", "line": 1, "side": "new"}, "text": "Written then"}))
        .await
        .unwrap();
    let after = ways.branch_comment("Written now", None).await;
    assert_eq!(after.session.id, before.session.id);
    assert_eq!(ways.target_of(&before.session.id), range("origin/main"));
    assert_eq!(
        ways.bodies(&before.session.id),
        vec!["Written then", "Written now"]
    );
    assert_eq!(ways.reviews(), 1);
}

#[tokio::test]
async fn an_agents_range_of_the_checked_out_branch_joins_the_branch_scopes_review() {
    let Some(bun) = bun() else { return };
    let repository = repository();
    let ways = Ways::new(bun, &repository.root);
    let branch = ways.branch_comment("On the branch", None).await;
    let by_agent = ways.agent_open(Some(("main", "topic"))).await;
    assert_eq!(by_agent.session.id, branch.session.id);
    assert_eq!(ways.reviews(), 1);
    git(&repository.root, &["branch", "older", "HEAD~1"]);
    let other = ways.agent_open(Some(("main", "older"))).await;
    assert_ne!(other.session.id, branch.session.id);
    assert_eq!(
        ways.agent_open(Some(("main", "older"))).await.session.id,
        other.session.id
    );
}
