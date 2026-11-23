//! shared/workspaceTree.ts, held to contract/vectors/workspace-tree.json as
//! `bun test` holds the TS.

use roamgate_protocol::vectors::{self, Call};

use super::*;

/// `{"$map": [[k, v]]}` as its pairs.
fn map_pairs(value: &Value) -> Vec<(String, Value)> {
    let (_, body) = vectors::tag(value).expect("a $map");
    body.as_array()
        .unwrap()
        .iter()
        .map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].clone()))
        .collect()
}

fn as_map(pairs: Vec<(String, Value)>) -> Value {
    json!({ "$map": pairs.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>() })
}

fn undefined() -> Value {
    json!({ "$undefined": true })
}

/// Ids the TS made up (`newNodeId`) are compared by shape.
fn normalize(value: &Value, generated: &Regex) -> Value {
    match value {
        Value::String(text) if generated.is_match(text) => json!("<generated>"),
        Value::Array(items) => {
            Value::Array(items.iter().map(|v| normalize(v, generated)).collect())
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), normalize(v, generated)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn arg(call: &Call, at: usize) -> Value {
    call.args.get(at).cloned().unwrap_or(Value::Null)
}

fn optional_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|each| each.as_str().unwrap().to_owned())
        .collect()
}

fn resolve_path(call: &Call) -> Value {
    let tree = arg(call, 0);
    let options = arg(call, 2);
    let mut answers: Vec<String> = options
        .get("newId")
        .and_then(vectors::tag)
        .map(|(_, body)| {
            body["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|call| call["result"].as_str().unwrap().to_owned())
                .collect()
        })
        .unwrap_or_default();
    answers.reverse();
    let recorded = options.get("newId").is_some();
    let mut next = move || answers.pop().expect("a recorded newId call");
    let resolution = resolve_workspace_tree_path(
        &tree,
        &strings(&arg(call, 1)),
        PathOptions {
            bases: options
                .get("bases")
                .and_then(Value::as_array)
                .map(|bases| bases.iter().map(optional_str).collect())
                .unwrap_or_default(),
            create: options.get("create") == Some(&Value::Bool(true)),
            prefer_connection: options.get("preferConnection").and_then(optional_str),
            new_id: if recorded {
                Some(&mut next as &mut dyn FnMut() -> String)
            } else {
                None
            },
        },
    );
    resolution.map_or(Value::Null, |resolution| resolution.to_json())
}

fn run(call: &Call) -> Result<Value, String> {
    let tree = arg(call, 0);
    let fail = |error: TreeError| error.0;
    Ok(match call.target().as_str() {
        "workspaceTree.emptyWorkspaceTree" => empty_workspace_tree(),
        "workspaceTree.applyWorkspaceTreeOp" => {
            apply_workspace_tree_op(&tree, &arg(call, 1)).map_err(fail)?
        }
        "workspaceTree.workspaceTreeChildren" => {
            Value::Array(workspace_tree_children(&tree, arg(call, 1).as_str()))
        }
        "workspaceTree.findWorkspaceNode" => find_workspace_node(&tree, &arg(call, 1))
            .cloned()
            .unwrap_or_else(undefined),
        "workspaceTree.resolveWorkspaceTreePath" => resolve_path(call),
        "workspaceTree.goneWorkspaceTreeNodes" => {
            let closed = call
                .args
                .get(3)
                .filter(|closed| !vectors::is_undefined(closed));
            json!(gone_workspace_tree_nodes(
                &tree,
                arg(call, 1).as_str().unwrap(),
                arg(call, 2).as_array().unwrap(),
                closed,
            ))
        }
        "workspaceTree.parseWorkspaceTreeOp" => {
            parse_workspace_tree_op(&tree).unwrap_or(Value::Null)
        }
        "workspaceTree.workspaceTreeRootPlace" => {
            workspace_tree_root_place(&tree).map_or(Value::Null, Value::String)
        }
        "workspaceTree.autoPlaceWorkspace" => {
            auto_place_workspace(&tree, &arg(call, 1), &arg(call, 2))
                .map_err(fail)?
                .unwrap_or(tree)
        }
        "workspaceTree.parseWorkspaceTree" => parse_workspace_tree(call.args.first()),
        "workspaceTree.resolveWorkspaceTree" => {
            let live: Vec<(String, Vec<Value>)> = map_pairs(&arg(call, 1))
                .into_iter()
                .map(|(connection, list)| (connection, list.as_array().unwrap().clone()))
                .collect();
            let resolved = resolve_workspace_tree(&tree, &live);
            json!({
                "nodes": as_map(resolved.nodes.iter().map(|(id, state)| (id.clone(), state.to_json())).collect()),
                "nodeByWorkspace": as_map(resolved.node_by_workspace.iter().map(|(key, id)| (key.clone(), json!(id))).collect()),
                "refreshes": resolved.refreshes,
            })
        }
        "workspaceTree.parseWorkspaceTreePath" => {
            json!(parse_workspace_tree_path(tree.as_str().unwrap()))
        }
        "workspaceTree.workspaceTreeNodePlaced" => json!(workspace_tree_node_placed(&tree)),
        "workspaceTree.workspaceTreeAncestors" => {
            json!(workspace_tree_ancestors(&tree, arg(call, 1).as_str()))
        }
        "workspaceTree.removeWorkspaceTreeNodes" => {
            remove_workspace_tree_nodes(&tree, &strings(&arg(call, 1))).map_err(fail)?
        }
        "workspaceTree.workspaceRefFor" => workspace_ref_for(tree.as_str().unwrap(), &arg(call, 1)),
        "workspaceTree.workspaceTreeGroupPaths" => Value::Array(
            workspace_tree_group_paths(&tree)
                .iter()
                .map(GroupPath::to_json)
                .collect(),
        ),
        other => panic!("no Rust function for {other}"),
    })
}

#[test]
fn holds_to_the_workspace_tree_vectors() {
    let file = vectors::load("workspace-tree");
    let generated = Regex::new(
        file.normalize.as_ref().unwrap()["generated_ids"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let mut calls = 0;
    for case in &file.cases {
        for call in &case.calls {
            calls += 1;
            let title = format!("{} > {}", case.title(), call.target());
            let answer = run(call);
            if let Some(message) = &call.throws {
                assert_eq!(answer.as_ref().err(), Some(message), "{title}");
                continue;
            }
            let answer = answer.unwrap_or_else(|error| panic!("{title}: {error}"));
            let expected = match call.same_as_arg {
                Some(at) => call.args[at].clone(),
                // A recorded `null` reads back as no result.
                None => call.result.clone().unwrap_or(Value::Null),
            };
            assert_eq!(
                normalize(&answer, &generated).to_string(),
                normalize(&expected, &generated).to_string(),
                "{title}"
            );
        }
    }
    assert!(calls > 150);
}

#[test]
fn generated_ids_have_the_shape_the_vectors_expect() {
    let generated = Regex::new("^[wg][0-9a-z]{12,}$").unwrap();
    let tree = apply_workspace_tree_op(
        &empty_workspace_tree(),
        &json!({
            "op": "move",
            "subject": { "workspace": { "connection_id": "c", "path": "/a" } },
            "parent": { "workspace": { "connection_id": "c", "path": "/b" } },
        }),
    )
    .unwrap();
    for node in tree["nodes"].as_array().unwrap() {
        assert!(generated.is_match(node["id"].as_str().unwrap()), "{node}");
    }
    assert!(generated.is_match(&new_workspace_tree_group_id()));
}
