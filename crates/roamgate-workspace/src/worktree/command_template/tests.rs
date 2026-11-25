//! command-template.test.ts.

#[cfg(unix)]
use std::process::Command;

use super::*;

fn values(path: Option<&str>, branch: Option<&str>) -> WorktreeCommandValues {
    WorktreeCommandValues {
        path: path.map(str::to_owned),
        branch: branch.map(str::to_owned),
        ..Default::default()
    }
}

#[test]
fn refuses_placeholders_inside_quotes_allows_them_bare() {
    for template in [
        r#"mk "{path}""#,
        "mk '{branch}'",
        r#"mk "x{base}y""#,
        "sh -c 'mk {repo}'",
        r#"mk "$(echo {path})""#,
    ] {
        let error = worktree_command_template_error(template).unwrap();
        assert!(error.contains("Remove the quotes around"), "{template}");
    }
    for template in [
        "git recworktree add {path} --branch {branch} --base {base}",
        r#"mk {path} "literal 'text'" '{not a placeholder}' \"{path}"#,
        "rm {path} {force}",
    ] {
        assert_eq!(
            worktree_command_template_error(template),
            None,
            "{template}"
        );
    }
    assert!(
        worktree_command_template_error(r#"mk {path} "open"#)
            .unwrap()
            .contains("unterminated")
    );
}

#[cfg(unix)]
#[test]
fn passes_hostile_values_as_data_to_a_real_sh() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("pwned");
    let marker = marker.to_str().unwrap();
    let hostile = format!("a$(touch${{IFS}}{marker})`touch ${{IFS}}{marker}`'\"; touch {marker}");
    let script = worktree_command_script(
        "printf '%s|%s|%s|%s' {branch} {base} {repo} {path}",
        &WorktreeCommandValues {
            path: Some(hostile.clone()),
            branch: Some(hostile.clone()),
            base: Some(hostile.clone()),
            repo: Some(hostile.clone()),
            force: false,
        },
    )
    .unwrap();
    let run = Command::new("sh")
        .args(["-c", &format!("{}; {}", script.exports, script.command)])
        .output()
        .unwrap();
    assert!(run.status.success());
    assert_eq!(
        String::from_utf8(run.stdout).unwrap(),
        [hostile.as_str(); 4].join("|")
    );
    assert!(!std::path::Path::new(marker).exists());
    let refused =
        worktree_command_script(r#"printf '%s' "{branch}""#, &values(None, Some(&hostile)))
            .unwrap_err();
    assert!(refused.contains("Remove the quotes around {branch}"));
}

#[cfg(unix)]
#[test]
fn expands_a_path_on_the_host_and_force_to_force_or_nothing() {
    let script = worktree_command_script(
        "rm {path} {force}",
        &WorktreeCommandValues {
            path: Some("~/w t".into()),
            force: true,
            ..Default::default()
        },
    )
    .unwrap();
    let run = Command::new("sh")
        .args([
            "-c",
            &format!("{}; printf %s \"$ROAMGATE_WORKTREE_PATH\"", script.exports),
        ])
        .env("HOME", "/home/x")
        .output()
        .unwrap();
    assert_eq!(String::from_utf8(run.stdout).unwrap(), "/home/x/w t");
    assert_eq!(script.command, r#"rm "$ROAMGATE_WORKTREE_PATH" --force"#);
    assert!(
        worktree_command_script("rm {branch}", &values(Some("/p"), None))
            .unwrap_err()
            .contains("{branch} is not available")
    );
}

#[test]
fn runs_under_sh_c_over_ssh_whatever_the_login_shell() {
    let Invocation::Ssh {
        destination,
        command,
        ..
    } = worktree_shell_invocation(Some("host"), r#"printf '%s' "$X""#)
    else {
        panic!("not over ssh");
    };
    assert_eq!(destination, "host");
    assert_eq!(command, r#"sh -c 'printf '\''%s'\'' "$X"'"#);
    assert_eq!(
        worktree_shell_invocation(None, "true"),
        Invocation::local(["sh", "-lc", "true"])
    );
}

#[test]
fn accepts_ordinary_branch_names() {
    for branch in ["feature/x", "fix-123", "user/topic.v2", "a_b+c"] {
        assert_eq!(validate_worktree_branch_name(branch), Ok(branch));
    }
}

#[test]
fn refuses_git_invalid_names_and_shell_syntax() {
    for branch in [
        "",
        "a$(touch${IFS}/tmp/x)",
        "a`id`",
        "a;b",
        "a b",
        "a|b",
        "it's",
        "\"q\"",
        "-x",
        "a..b",
        "a//b",
        "/a",
        "a/",
        "a.",
        ".a",
        "a/.b",
        "a.lock",
        "a@{1}",
        "@",
        "a~1",
        "a^",
        "a:b",
        "a?",
        "a*",
        "a[b",
        "a\\b",
        "a\nb",
    ] {
        let error = validate_worktree_branch_name(branch).unwrap_err();
        assert!(error.contains("Invalid branch name"), "{branch:?}");
    }
}

#[test]
fn names_the_program_and_git_subcommand_a_template_starts_with() {
    let program = |p: &str, s: Option<&str>| {
        Some(WorktreeCommandProgram {
            program: p.into(),
            subcommand: s.map(str::to_owned),
        })
    };
    assert_eq!(
        worktree_command_program("git recworktree add {path}"),
        program("git", Some("recworktree"))
    );
    assert_eq!(
        worktree_command_program("git -C x worktree add"),
        program("git", None)
    );
    assert_eq!(
        worktree_command_program("  mk-tree {path}"),
        program("mk-tree", None)
    );
    assert_eq!(worktree_command_program("FOO=1 mk {path}"), None);
    assert_eq!(worktree_command_program("(cd x && mk)"), None);
}

#[cfg(unix)]
#[test]
fn exits_127_only_for_a_missing_program_or_git_subcommand_with_a_real_sh() {
    let probe = |template: &str| {
        Command::new("sh")
            .args(["-c", &worktree_command_probe_script(template).unwrap()])
            .status()
            .unwrap()
            .code()
    };
    assert_eq!(probe("sh -c true"), Some(0));
    assert_eq!(probe("git worktree add {path}"), Some(0));
    assert_eq!(probe("roamgate-no-such-tool {path}"), Some(127));
    assert_eq!(probe("git roamgate-no-such-subcommand {path}"), Some(127));
}

#[test]
fn an_escaped_placeholder_is_refused_before_its_inserted_quote_can_be_escaped() {
    assert!(
        worktree_command_script("mk \\{path}", &values(Some("/a b"), None))
            .unwrap_err()
            .contains("escape")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn says_which_program_is_missing_on_the_host() {
    let cx = GitContext::local(std::sync::Arc::new(
        roamgate_git::exec::LocalRunner::system(),
    ));
    assert_eq!(
        missing_worktree_command("roamgate-no-such-tool {path}", &cx).await,
        Ok(Some(
            "roamgate-no-such-tool is not installed on this machine.".into()
        ))
    );
    assert_eq!(
        missing_worktree_command("git worktree add {path}", &cx).await,
        Ok(None)
    );
    assert_eq!(missing_worktree_command("(cd x)", &cx).await, Ok(None));
}
