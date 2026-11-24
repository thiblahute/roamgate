use std::sync::Mutex;

use super::*;
use crate::area::AreaRender;

/// An area whose render is whatever the test sets.
struct Fixed {
    name: &'static str,
    render: Mutex<Result<AreaRender, String>>,
    describe: Option<fn(&[String]) -> String>,
}

impl Fixed {
    fn new(name: &'static str, files: &[(&str, &str)], owns: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            name,
            render: Mutex::new(Ok(render(files, owns))),
            describe: None,
        })
    }

    fn set(&self, files: &[(&str, &str)], owns: &[&str]) {
        *self.render.lock().unwrap() = Ok(render(files, owns));
    }
}

fn render(files: &[(&str, &str)], owns: &[&str]) -> AreaRender {
    AreaRender {
        files: files
            .iter()
            .map(|(path, text)| ((*path).to_owned(), text.as_bytes().to_vec()))
            .collect(),
        owns: owns.iter().map(|owned| (*owned).to_owned()).collect(),
    }
}

impl HistoryArea for Fixed {
    fn name(&self) -> &str {
        self.name
    }
    fn render(&self, _ids: Option<&[String]>) -> Result<AreaRender, String> {
        self.render.lock().unwrap().clone()
    }
    fn describe(&self, paths: &[String]) -> Option<String> {
        self.describe.map(|describe| describe(paths))
    }
}

fn repo() -> (tempfile::TempDir, HistoryRepo) {
    let temp = tempfile::tempdir().unwrap();
    let repo = HistoryRepo::new(&temp.path().join("history"), "desk", false, None);
    (temp, repo)
}

fn git(repo: &HistoryRepo, args: &[&str]) -> String {
    let result = repo.run(args);
    assert_eq!(result.code, 0, "{}", result.stderr);
    js::trim(&result.stdout).to_owned()
}

fn all(area: Arc<dyn HistoryArea>) -> PassInput {
    PassInput {
        areas: vec![(area, None)],
        ..PassInput::default()
    }
}

#[test]
fn a_new_repo_has_format_and_readme_md_committed_by_roamgate() {
    let (_temp, history) = repo();
    history.ensure().unwrap();
    assert_eq!(
        std::fs::read_to_string(history.dir.join("FORMAT")).unwrap(),
        "1\n"
    );
    assert!(history.dir.join("README.md").exists());
    assert_eq!(
        git(&history, &["log", "--format=%an <%ae>|%cn|%B"]),
        "Roamgate <roamgate@desk>|Roamgate|Start the Roamgate history\n\nRoamgate-Host: desk"
    );
    // Again: nothing new.
    history.ensure().unwrap();
    assert_eq!(git(&history, &["rev-list", "--count", "HEAD"]), "1");
}

#[test]
fn a_newer_layout_is_refused() {
    let (_temp, history) = repo();
    history.ensure().unwrap();
    std::fs::write(history.dir.join("FORMAT"), "2\n").unwrap();
    let error = history.ensure().unwrap_err();
    assert!(error.contains("format 2"), "{error}");
}

#[test]
fn a_pass_writes_what_changed_removes_what_is_gone_and_commits_once() {
    let (_temp, history) = repo();
    let notes = Arc::new(Fixed {
        name: "notes",
        render: Mutex::new(Ok(render(
            &[("notes/a.json", "{}\n"), ("notes/b.json", "[]\n")],
            &["notes/"],
        ))),
        describe: Some(|changed| format!("{} notes", changed.len())),
    });
    let result = history.pass(&all(notes.clone())).unwrap();
    assert_eq!(
        (result.commits, result.blocked.len(), result.errors.len()),
        (1, 0, 0)
    );
    assert_eq!(
        git(&history, &["log", "-1", "--format=%s%n%b"]),
        "notes: 2 notes\n- notes/a.json\n- notes/b.json\n\nRoamgate-Host: desk"
    );
    // The same files: no commit.
    assert_eq!(history.pass(&all(notes.clone())).unwrap().commits, 0);
    notes.set(&[("notes/a.json", "{\"x\":1}\n")], &["notes/"]);
    assert_eq!(history.pass(&all(notes.clone())).unwrap().commits, 1);
    assert!(!history.dir.join("notes").join("b.json").exists());
    assert_eq!(
        git(&history, &["show", "--name-status", "--format=", "HEAD"]),
        "M\tnotes/a.json\nD\tnotes/b.json"
    );
    let status = history.status();
    assert!(status.exists);
    assert_eq!(status.commits, 3);
    let files: std::collections::BTreeMap<_, _> = status.files.iter().cloned().collect();
    assert_eq!(files.get("notes"), Some(&1));
    assert_eq!(files.get("FORMAT"), Some(&1));
    assert_eq!(files.get("README.md"), Some(&1));
    assert_eq!(status.last_pass.as_ref().map(|pass| pass.commits), Some(1));
    assert_eq!(status.last_commit.unwrap().author, "Roamgate");
    assert!(status.size_bytes > 0);
}

#[test]
fn a_render_owns_only_its_paths_star_stands_for_any_directory() {
    let (_temp, history) = repo();
    let whole = Fixed::new(
        "r",
        &[
            ("r/2025/s1/a.md", "a\n"),
            ("r/2026/s2/b.md", "b\n"),
            ("r/images/x.png", "png"),
        ],
        &["r/"],
    );
    history.pass(&all(whole)).unwrap();
    let one = Fixed::new("r", &[], &["r/*/s1/"]);
    history
        .pass(&PassInput {
            areas: vec![(one, Some(vec!["s1".into()]))],
            ..PassInput::default()
        })
        .unwrap();
    assert_eq!(
        git(&history, &["ls-files", "r"]),
        "r/2026/s2/b.md\nr/images/x.png"
    );
    assert!(owned_by("r/*/s1/", "r/2025/s1/a.md"));
    assert!(!owned_by("r/*/s1/", "r/2025/s10/a.md"));
    assert!(owned_by("a.json", "a.json"));
    assert!(!owned_by("a.json", "a.jsonx"));
}

#[test]
fn a_secret_keeps_its_file_out_of_the_commit_named_in_the_status() {
    let (_temp, history) = repo();
    let notes = Fixed::new(
        "notes",
        &[
            ("notes/clean.md", "nothing here\n"),
            (
                "notes/leak.md",
                "line one\nmy token glpat-abcdefghijklmnopqrst\n",
            ),
        ],
        &["notes/"],
    );
    let result = history.pass(&all(notes.clone())).unwrap();
    assert_eq!(result.commits, 1);
    assert_eq!(
        result.blocked,
        [HistoryBlocked {
            file: "notes/leak.md".into(),
            line: 2,
            kind: "glpat-... token".into()
        }]
    );
    assert_eq!(git(&history, &["ls-files", "notes"]), "notes/clean.md");
    assert!(!git(&history, &["log", "--all", "-p"]).contains("glpat-"));
    assert_eq!(history.status().blocked.len(), 1);
    // Still there next time, still out.
    let again = history.pass(&all(notes)).unwrap();
    assert_eq!(again.commits, 0);
    assert_eq!(again.blocked.len(), 1);
}

#[test]
fn work_changes_are_one_commit_each_by_their_author_at_their_time() {
    let (_temp, history) = repo();
    let path = "work/items/i1.md";
    let change = |content: Option<&str>,
                  name: &str,
                  email: &str,
                  date: &str,
                  subject: &str,
                  body: Option<&str>| WorkCommit {
        path: path.into(),
        content: content.map(str::to_owned),
        author: GitAuthor {
            name: name.into(),
            email: email.into(),
        },
        date: date.into(),
        subject: subject.into(),
        body: body.map(str::to_owned),
    };
    let result = history
        .pass(&PassInput {
            work: vec![
                change(
                    Some("one\n"),
                    "me",
                    "me@desk",
                    "2026-11-20T10:00:00.000Z",
                    "work i1: state open",
                    None,
                ),
                change(
                    Some("two\n"),
                    "Claude (desktop/w1:p1)",
                    "agent@desk",
                    "2026-11-21T11:30:00.000Z",
                    "work i1: state doing",
                    Some("By Claude at desktop/w1:p1."),
                ),
                // Nothing changed: no commit.
                change(
                    Some("two\n"),
                    "me",
                    "me@desk",
                    "2026-11-21T12:00:00.000Z",
                    "work i1: updated",
                    None,
                ),
                change(
                    None,
                    "me",
                    "me@desk",
                    "2026-11-22T09:00:00.000Z",
                    "work i1: removed",
                    None,
                ),
            ],
            ..PassInput::default()
        })
        .unwrap();
    assert_eq!((result.commits, result.errors.len()), (3, 0));
    assert_eq!(
        git(
            &history,
            &["log", "--format=%an|%ae|%aI|%cn|%s", "--", path]
        ),
        [
            "me|me@desk|2026-11-22T09:00:00Z|Roamgate|work i1: removed",
            "Claude (desktop/w1:p1)|agent@desk|2026-11-21T11:30:00Z|Roamgate|work i1: state doing",
            "me|me@desk|2026-11-20T10:00:00Z|Roamgate|work i1: state open",
        ]
        .join("\n")
    );
    assert_eq!(
        git(&history, &["log", "-1", "--skip=1", "--format=%b"]),
        "By Claude at desktop/w1:p1.\n\nRoamgate-Host: desk"
    );
}

#[test]
fn one_pass_at_a_time_across_processes() {
    let (_temp, history) = repo();
    history.ensure().unwrap();
    let lock = history.dir.join(".git").join("roamgate-pass.lock");
    std::fs::create_dir(&lock).unwrap();
    let notes = Fixed::new("notes", &[("n.json", "1\n")], &["n.json"]);
    let locked = history.pass(&all(notes.clone())).unwrap();
    assert!(locked.locked);
    assert_eq!(locked.commits, 0);
    std::fs::remove_dir_all(&lock).unwrap();
    assert_eq!(history.pass(&all(notes)).unwrap().commits, 1);
}

#[test]
fn an_area_that_fails_is_reported_the_others_are_committed() {
    let (_temp, history) = repo();
    let broken = Arc::new(Fixed {
        name: "broken",
        render: Mutex::new(Err("cannot read".into())),
        describe: None,
    });
    let fine = Fixed::new("fine", &[("fine.json", "1\n")], &["fine.json"]);
    let result = history
        .pass(&PassInput {
            areas: vec![(broken, None), (fine, None)],
            ..PassInput::default()
        })
        .unwrap();
    assert_eq!(result.commits, 1);
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].area.as_deref(), Some("broken"));
    assert_eq!(result.errors[0].message, "cannot read");
    assert_eq!(history.status().errors.len(), 1);
}

#[test]
fn the_user_s_git_config_does_not_sign_hook_or_author() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join(".gitconfig"),
        "[user]\n\tname = Someone\n\temail = someone@example.org\n[commit]\n\tgpgsign = true\n",
    )
    .unwrap();
    // The repo's git with that HOME, as the server's environment would give it.
    let dir = temp.path().join("history");
    let inner = crate::git::git_runner(&dir, None, false);
    let home_env = home.display().to_string();
    let git: GitRunner = Arc::new(move |args, run| {
        let mut run = run.clone();
        run.env.insert(0, ("HOME".into(), home_env.clone()));
        inner(args, &run)
    });
    let history = HistoryRepo::with_git(&dir, "desk", git, None);
    history.ensure().unwrap();
    assert_eq!(
        git_of(&history, &["log", "-1", "--format=%an|%cn"]),
        "Roamgate|Roamgate"
    );
}

fn git_of(repo: &HistoryRepo, args: &[&str]) -> String {
    git(repo, args)
}
