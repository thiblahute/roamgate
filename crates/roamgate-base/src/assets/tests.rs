//! server/src/assets/assets.test.ts.

use std::path::{Path, PathBuf};

use super::*;

fn assets_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/assets")
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn files(dir: &Path, root: &Path, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files(&path, root, out);
        } else {
            out.push(
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

fn fill(template: &str, values: &[(&str, TemplateValue)]) -> String {
    fill_template(template, values).unwrap()
}

fn error(template: &str, values: &[(&str, TemplateValue)]) -> String {
    fill_template(template, values).unwrap_err().to_string()
}

#[test]
fn fills_values_and_keeps_everything_else() {
    assert_eq!(
        fill(
            "a={{a}} ${b} {x} {{b}}\n",
            &[("a", "'q'".into()), ("b", 2i64.into())]
        ),
        "a='q' ${b} {x} 2\n"
    );
}

#[test]
fn sections_keep_on_true_and_inverses_on_false() {
    let template = "[{{#on}}yes {{v}}{{/on}}{{^on}}no{{/on}}]";
    assert_eq!(
        fill(template, &[("on", true.into()), ("v", "x".into())]),
        "[yes x]"
    );
    assert_eq!(
        fill(template, &[("on", false.into()), ("v", "x".into())]),
        "[no]"
    );
}

#[test]
fn sections_nest() {
    let template = "{{#a}}A{{#b}}B{{/b}}{{/a}}";
    assert_eq!(
        fill(template, &[("a", true.into()), ("b", true.into())]),
        "AB"
    );
    assert_eq!(
        fill(template, &[("a", true.into()), ("b", false.into())]),
        "A"
    );
    assert_eq!(
        fill(template, &[("a", false.into()), ("b", true.into())]),
        ""
    );
}

#[test]
fn missing_unused_and_wrong_kinds_are_refused() {
    assert!(error("{{a}}", &[]).contains("no value for {{a}}"));
    assert!(error("x", &[("a", "1".into())]).contains("no {{a}} to fill"));
    assert!(error("{{a}}", &[("a", true.into())]).contains("flag"));
    assert!(error("{{#a}}{{/a}}", &[("a", "1".into())]).contains("true or false"));
    assert!(error("{{#a}}", &[("a", true.into())]).contains("not closed"));
    assert!(error("{{#a}}{{/b}}", &[("a", true.into()), ("b", true.into())]).contains("closes"));
    assert!(error("{{toString}}", &[]).contains("no value"));
}

#[test]
fn lists_a_templates_tags() {
    assert_eq!(
        template_names("{{#a}}{{b}}{{/a}}{{^c}}{{/c}}{{b}}").unwrap(),
        vec!["a", "b", "c"]
    );
}

#[test]
fn every_file_is_embedded_and_every_embedded_text_is_a_file() {
    let root = assets_dir();
    let mut on_disk = Vec::new();
    files(&root, &root, &mut on_disk);
    let mut on_disk: Vec<String> = on_disk
        .into_iter()
        .filter(|path| path != "index.json" && path != "README.md" && !path.ends_with(".json"))
        .collect();
    on_disk.sort();
    let mut embedded: Vec<String> = ASSET_TEXTS
        .iter()
        .map(|(path, _)| (*path).to_owned())
        .collect();
    embedded.sort();
    assert_eq!(embedded, on_disk);
    for (path, text) in ASSET_TEXTS {
        assert_eq!(
            *text,
            std::fs::read_to_string(root.join(path)).unwrap(),
            "{path}"
        );
    }
    let disk: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("data/voice-models.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(voice_models(), &disk);
    assert!(!mod_via().is_empty());
}

#[test]
fn every_template_parses() {
    for (path, text) in ASSET_TEXTS {
        assert!(template_names(text).is_ok(), "{path}");
    }
}

#[test]
fn the_index_gives_each_files_kind_and_tags() {
    // index.json is written by scripts/contract/assets-index.ts, which also
    // lists each file's users in the TS server: here, its kinds and tags
    // are held to the files.
    let index: Value =
        serde_json::from_str(&std::fs::read_to_string(assets_dir().join("index.json")).unwrap())
            .unwrap();
    let index = index.as_object().unwrap();
    let kinds = [
        ("data", "data, read as JSON"),
        ("html", "page, a template"),
        (
            "js",
            "page script, built from web/src (bun run build:assets)",
        ),
        (
            "ps1",
            "PowerShell run on a Windows host, a template when it has tags",
        ),
        (
            "python",
            "Python 3 run on a host (the clients are installed there as files)",
        ),
        (
            "sh",
            "POSIX shell run on a host, a template when it has tags",
        ),
        ("skill", "installed on hosts beside roamgate-review"),
    ];
    let mut listed: Vec<&str> = index.keys().map(String::as_str).collect();
    listed.sort();
    let mut expected: Vec<&str> = ASSET_TEXTS
        .iter()
        .map(|(path, _)| *path)
        .chain(["data/voice-models.json"])
        .collect();
    expected.sort();
    assert_eq!(listed, expected);
    for (path, text) in ASSET_TEXTS {
        let entry = &index[*path];
        let directory = path.split('/').next().unwrap();
        let kind = kinds.iter().find(|(dir, _)| *dir == directory).unwrap().1;
        assert_eq!(entry["kind"], kind, "{path}");
        let tags: Vec<String> = serde_json::from_value(entry["tags"].clone()).unwrap();
        assert_eq!(tags, template_names(text).unwrap(), "{path}");
    }
}

/// A string constant of a TS file: `NAME =` then a string literal.
fn ts_constant(file: &str, name: &str) -> String {
    let text = std::fs::read_to_string(repo().join(file)).unwrap();
    let after = &text[text.find(&format!("export const {name} =")).unwrap()..];
    let start = after.find('"').unwrap();
    let mut out = String::new();
    let mut chars = after[start + 1..].chars();
    while let Some(character) = chars.next() {
        match character {
            '\\' => {
                let escaped = chars.next().unwrap();
                out.push(match escaped {
                    'n' => '\n',
                    other => other,
                });
            }
            '"' => break,
            other => out.push(other),
        }
    }
    out
}

#[test]
fn the_installed_clients_carry_the_servers_constants() {
    let json = |text: &str| serde_json::to_string(text).unwrap();
    let question = ts_constant("shared/review.ts", "DISMISSED_QUESTION_MESSAGE");
    let permission = ts_constant("shared/review.ts", "DISMISSED_PERMISSION_MESSAGE");
    assert!(ROAMGATE_REVIEW_PY.contains(&format!("\nDISMISSED_QUESTION = {}\n", json(&question))));
    assert!(
        ROAMGATE_REVIEW_PY.contains(&format!("\nDISMISSED_PERMISSION = {}\n", json(&permission)))
    );
    let start_env = ts_constant("shared/agentChat.ts", "CLAUDE_START_ENV");
    for client in [ROAMGATE_REVIEW_PY, ROAMGATE_HOLD_PY] {
        assert!(client.contains(&format!("\nSTART_ENV = \"{start_env}\"\n")));
    }
    let command = ts_constant(
        "server/src/conversation/claude-start-hook.ts",
        "CLAUDE_START_HOOK_COMMAND",
    );
    assert!(CLAUDE_START_HOOK_INSTALL_PY.contains(&format!("\nCOMMAND = {}\n", json(&command))));
    assert!(CLAUDE_START_HOOK_INSTALL_PY.contains("\nMARK = \"roamgate-review claude-start\"\n"));
    for client in [
        ROAMGATE_REVIEW_PY,
        ROAMGATE_HOLD_PY,
        CLAUDE_START_HOOK_INSTALL_PY,
    ] {
        assert!(template_names(client).unwrap().is_empty());
    }
}

#[test]
fn the_rendered_helper_is_the_built_file_and_safe_in_a_script_tag() {
    // The file is built from web/src/renderedHelper.ts by the web toolchain
    // (Vite under Bun); bun test rebuilds and compares it. Rust embeds the
    // built file: it must be that file, and safe inside <script>.
    assert!(!RENDERED_HELPER_JS.contains("</script"));
    assert_eq!(
        RENDERED_HELPER_JS,
        std::fs::read_to_string(assets_dir().join("js/rendered-helper.js")).unwrap()
    );
}
