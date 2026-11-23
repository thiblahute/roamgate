//! The inbox entry of each planned request of an effort, for its Board
//! (`mr-reviews/effort-board.ts`).

use std::collections::{HashMap, HashSet};

use roamgate_agents::js::{self, Obj};
use serde_json::Value;

use crate::upstream::{PatchIds, UpstreamBranch, request_of_branch};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn project_of(provider: &str, host: &str, project: &str) -> String {
    format!(
        "{provider}:{}/{}",
        js::js_lower(host),
        js::js_lower(project)
    )
}

/// `effortPlanEntries`: the request each planned part's branch is (at the
/// branch's head, else by name, else by the patch ids of its commits, as
/// the inbox links branches), else that branch's own row (not proposed
/// yet). The request's source branch may be the part's branch, the branch
/// it was made from, or `upstream/<part branch>` (a fork's naming). A part
/// whose checkout was not read (not ahead of its target, not headed
/// upstream) is found by those names among the user's requests. Nothing
/// here asks a forge: the entries are the inbox's as computed. The answer
/// is by plan id, in the plans' order.
pub fn effort_plan_entries(
    group: &str,
    plans: &[Value],
    branches: &[UpstreamBranch],
    entries: &[Obj],
    patch_ids: &PatchIds,
) -> Obj {
    let requests: Vec<&Obj> = entries
        .iter()
        .filter(|entry| !truthy(entry.get("branch")) && !truthy(entry.get("unavailable")))
        .collect();
    let mut by_key: HashMap<&str, &Obj> = HashMap::new();
    for entry in entries {
        by_key.insert(js::sv(entry.get("key")), entry);
    }
    // The effort's project: the target its branches are compared with.
    let projects: HashSet<String> = branches
        .iter()
        .filter(|branch| branch.member.group == group)
        .map(|branch| project_of(&branch.provider, &branch.host, &branch.project))
        .collect();
    let in_project = |entry: &Obj| {
        projects.is_empty()
            || projects.contains(&project_of(
                js::sv(entry.get("provider")),
                js::sv(entry.get("host")),
                js::sv(entry.get("project")),
            ))
    };
    let mut out = Obj::new();
    for plan in plans {
        let Some(part) = plan.get("part").filter(|part| truthy(Some(part))) else {
            continue;
        };
        let text = |key: &str| part.get(key).and_then(Value::as_str);
        let part_branch = js::sv(part.get("branch"));
        let plan_id = js::sv(plan.get("id"));
        let branch = branches
            .iter()
            .find(|each| {
                Some(each.member.connection_id.as_str()) == text("connectionId")
                    && Some(each.member.path.as_str()) == text("path")
            })
            .or_else(|| {
                branches
                    .iter()
                    .find(|each| each.branch == part_branch && each.member.group == group)
            });
        let mut names: Vec<String> = vec![part_branch.to_owned()];
        let mut add = |name: String| {
            if !names.contains(&name) {
                names.push(name);
            }
        };
        if let Some(from) = text("from").filter(|from| !from.is_empty()) {
            add(from.to_owned());
        }
        if !part_branch.starts_with("upstream/") {
            add(format!("upstream/{part_branch}"));
        }
        if let Some(branch) = branch {
            let request = request_of_branch(branch, requests.iter().copied(), patch_ids, &names);
            let key = match request {
                Some(request) => js::sv(request.get("key")),
                None => branch.key.as_str(),
            };
            if let Some(found) = by_key.get(key) {
                out.insert(plan_id.to_owned(), Value::Object((*found).clone()));
            }
            continue;
        }
        let named: Vec<&Obj> = requests
            .iter()
            .copied()
            .filter(|entry| {
                entry
                    .get("reasons")
                    .and_then(Value::as_array)
                    .is_some_and(|reasons| reasons.iter().any(|reason| reason == "authored"))
                    && entry.get("state").and_then(Value::as_str) != Some("closed")
                    && entry
                        .get("sourceBranch")
                        .and_then(Value::as_str)
                        .is_some_and(|source| names.iter().any(|name| name == source))
                    && in_project(entry)
            })
            .collect();
        let found = named
            .iter()
            .find(|entry| entry.get("state").and_then(Value::as_str) == Some("open"))
            .or_else(|| named.first());
        if let Some(found) = found {
            out.insert(plan_id.to_owned(), Value::Object((*found).clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    //! `effort-board.test.ts`.

    use serde_json::json;

    use super::*;
    use crate::upstream::{BranchCommit, Counted, UpstreamMember};

    const HOST: &str = "gitlab.example.org";
    const PROJECT: &str = "media/engine";

    fn obj(value: Value) -> Obj {
        match value {
            Value::Object(map) => map,
            _ => Obj::new(),
        }
    }

    fn entry(number: u64, extra: Value) -> Obj {
        let mut entry = obj(json!({
            "provider": "gitlab",
            "host": HOST,
            "project": PROJECT,
            "number": number,
            "key": format!("gitlab:{HOST}/{PROJECT}#{number}"),
            "url": format!("https://{HOST}/{PROJECT}/-/merge_requests/{number}"),
            "title": format!("MR {number}"),
            "author": "me",
            "draft": false,
            "state": "open",
            "updatedAt": js::iso(js::now_ms()),
            "headSha": format!("head{number}"),
            "sourceBranch": format!("b{number}"),
            "targetBranch": "main",
            "pipeline": "success",
            "notes": 0,
            "reasons": ["authored"],
            "section": "authored",
            "unread": null,
            "isNew": false,
            "lane": "waiting",
        }));
        for (key, value) in obj(extra) {
            entry.insert(key, value);
        }
        entry
    }

    fn branch(name: &str, path: &str, patch_ids: &[&str]) -> UpstreamBranch {
        UpstreamBranch {
            key: format!("branch:gitlab:{HOST}/{PROJECT}@{name}"),
            provider: "gitlab".into(),
            host: HOST.into(),
            project: PROJECT.into(),
            branch: name.into(),
            member: UpstreamMember {
                connection_id: "local".into(),
                workspace_id: format!("w-{name}"),
                path: path.into(),
                label: name.into(),
                group: "g1".into(),
                ..UpstreamMember::default()
            },
            connection_label: "local".into(),
            head: format!("h-{name}"),
            dirty: 0.0,
            target: Counted {
                reference: "origin/main".into(),
                sha: "t".into(),
                ahead: patch_ids.len() as f64,
                ..Counted::default()
            },
            commits: patch_ids
                .iter()
                .enumerate()
                .map(|(index, id)| BranchCommit {
                    sha: format!("{name}-{index}"),
                    subject: format!("{name} {index}"),
                    at: 1.0,
                    patch_id: Some((*id).to_owned()),
                    own: false,
                })
                .collect(),
            ..UpstreamBranch::default()
        }
    }

    fn plan(id: &str) -> Value {
        json!({
            "id": id,
            "name": format!("Plan {id}"),
            "commits": [format!("{id}-1")],
            "dependsOn": [],
            "state": "accepted",
            "part": {"connectionId": "local", "path": format!("/wt/{id}"), "branch": format!("upstream/{id}")},
            "at": "",
            "by": "agent",
        })
    }

    fn number(linked: &Obj, id: &str) -> Option<u64> {
        linked.get(id).and_then(|entry| entry["number"].as_u64())
    }

    fn ids(pairs: &[(&Obj, &[&str])]) -> PatchIds {
        pairs
            .iter()
            .map(|(entry, ids)| {
                (
                    js::sv(entry.get("key")).to_owned(),
                    ids.iter().map(|id| (*id).to_owned()).collect(),
                )
            })
            .collect()
    }

    #[test]
    fn a_parts_branch_links_to_its_request_by_name_by_patch_ids_else_is_its_branch_row() {
        let plans: Vec<Value> = ["named", "byIds", "row", "none", "unscanned", "merged"]
            .iter()
            .map(|id| plan(id))
            .collect();
        let branches = vec![
            branch("upstream/named", "/wt/named", &["p1"]),
            // Renamed on the forge: found by its commits' patch ids.
            branch("upstream/byIds", "/wt/byIds", &["p2", "p3"]),
            branch("upstream/row", "/wt/row", &["p9"]),
        ];
        let mut row = entry(
            0,
            json!({"lane": "not_sent", "sourceBranch": "upstream/row"}),
        );
        row.insert("key".into(), json!(branches[2].key));
        row.insert(
            "branch".into(),
            json!({
                "name": "upstream/row", "connectionId": "local", "connectionLabel": "local",
                "workspaceId": "w-row", "workspaceLabel": "row", "path": "/wt/row",
                "target": "origin/main", "ahead": 1, "behind": 0, "dirty": 0, "commits": [], "group": "g1",
            }),
        );
        let entries = vec![
            // A GitHub-like cross-fork request from thiblahute:upstream/named.
            entry(
                1,
                json!({"sourceBranch": "upstream/named", "lane": "your_move"}),
            ),
            entry(
                2,
                json!({"sourceBranch": "something-else", "lane": "merging"}),
            ),
            entry(
                4,
                json!({"sourceBranch": "upstream/unscanned", "lane": "blocked"}),
            ),
            entry(
                5,
                json!({"sourceBranch": "upstream/merged", "state": "merged", "lane": "done"}),
            ),
            // A closed one leaves the work unproposed.
            entry(
                6,
                json!({"sourceBranch": "upstream/none", "state": "closed", "lane": "done"}),
            ),
            // The row the inbox draws for the branch with no request.
            row,
        ];
        let patch_ids = ids(&[(&entries[1], &["p2", "p3", "p4"])]);
        let linked = effort_plan_entries("g1", &plans, &branches, &entries, &patch_ids);
        assert_eq!(number(&linked, "named"), Some(1));
        assert_eq!(number(&linked, "byIds"), Some(2));
        assert_eq!(linked["row"]["key"], json!(branches[2].key));
        assert!(!linked.contains_key("none"));
        // Not read by the scan (not ahead, or outside the group): by its name.
        assert_eq!(number(&linked, "unscanned"), Some(4));
        assert_eq!(number(&linked, "merged"), Some(5));
        assert_eq!(
            linked.keys().collect::<Vec<_>>(),
            vec!["named", "byIds", "row", "unscanned", "merged"]
        );
        // Some of the branch's commits only: not that request.
        let partial = effort_plan_entries(
            "g1",
            &[plan("byIds")],
            &branches,
            &entries,
            &ids(&[(&entries[1], &["p2"])]),
        );
        assert!(!partial.contains_key("byIds"));
        // A request of another project is not one of the effort's.
        let elsewhere = effort_plan_entries(
            "g1",
            &[plan("unscanned")],
            &branches,
            &[entry(
                4,
                json!({"sourceBranch": "upstream/unscanned", "project": "other/app"}),
            )],
            &PatchIds::new(),
        );
        assert!(!elsewhere.contains_key("unscanned"));
    }

    #[tokio::test]
    async fn effort_get_gives_each_plan_its_inbox_entry_from_the_entries_computed() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};

        use roamgate_base::paths::{DataContext, Platform};

        use crate::effort_service::{
            EffortRpcDeps, EffortService, EffortServiceOptions, handle_effort_rpc,
        };
        use crate::order::ChangeMeta;
        use crate::upstream::UpstreamScanner;

        let dir = tempfile::tempdir().unwrap();
        let context = DataContext::new(dir.path(), Platform::current(), None);
        let the_effort = json!({"id": "e1", "group": "g1", "name": "Big",
            "clone": {"connectionId": "local", "path": "/clone"},
            "source": "refs/heads/big", "target": {"remote": "origin", "branch": "main"}, "feeders": []});
        let settings = Arc::new(Mutex::new(obj(json!({"efforts": [the_effort]}))));
        let settings_fn: crate::inbox::SettingsFn = {
            let settings = settings.clone();
            Arc::new(move || {
                let value = settings.lock().unwrap().clone();
                Box::pin(async move { value })
            })
        };
        let upstream = Arc::new(UpstreamScanner::new(
            Arc::new(Vec::new),
            Arc::new(|| Box::pin(async { Ok(json!({"nodes": []})) })),
            Arc::new(|| Box::pin(async { Ok(Obj::new()) })),
        ));
        upstream.seed(vec![branch("upstream/named", "/wt/named", &["p1"])], vec![]);
        let service = EffortService::new(EffortServiceOptions {
            context: context.clone(),
            root: dir.path().join("efforts"),
            settings: settings_fn.clone(),
            connections: Arc::new(Vec::new),
            items: Arc::new(Vec::new),
            upstream: upstream.clone(),
            publish: None,
            current: Arc::new(|| Box::pin(async { (json!(0), json!([])) })),
            now: None,
        });
        let mut ledger = service.store().ledger("e1");
        let mut planned_only = plan("planned-only");
        planned_only.as_object_mut().unwrap().shift_remove("part");
        ledger.insert("plans".into(), json!([plan("named"), planned_only]));
        service.store().write_ledger("e1", &ledger);
        let asked = Arc::new(AtomicUsize::new(0));
        let deps = EffortRpcDeps {
            service,
            settings: settings_fn,
            edit: Arc::new(|change| change),
            save: Arc::new(|value: Obj, _: ChangeMeta| Box::pin(async move { Ok(value) })),
            upstream,
            entries: Some({
                let asked = asked.clone();
                Arc::new(move || {
                    asked.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { vec![entry(1, json!({"sourceBranch": "upstream/named"}))] })
                })
            }),
            group_label: Arc::new(|_| Box::pin(async { None })),
            create_worktree: None,
            place: None,
            open_range: None,
            effort_review: None,
        };
        let answer = handle_effort_rpc(
            &deps,
            "bridge.mr_reviews.effort.get",
            &obj(json!({"id": "e1"})),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        let board = answer["board"].as_object().unwrap();
        assert_eq!(board.keys().collect::<Vec<_>>(), vec!["named"]);
        assert_eq!(board["named"]["number"], json!(1));
    }
}
